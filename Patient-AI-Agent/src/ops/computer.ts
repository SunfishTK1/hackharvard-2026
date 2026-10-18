// A Daytona computer for a manager's analyses: one cloud sandbox each, created on first use with the
// Python data stack, stopped by Daytona when idle and deleted a while after. It holds only the data
// snapshot an analysis uploads (export.ts): no database access, credentials or API keys.
import { Daytona, type Sandbox } from "@daytona/sdk";
import { config } from "../config.ts";
import { ops } from "./db.ts";

export const computersEnabled = () => Boolean(config.daytona.apiKey);

const PACKAGES = "pandas numpy scipy statsmodels matplotlib seaborn scikit-learn lifelines pyarrow openpyxl tabulate";
const IDLE_STOP_MINUTES = 30;
const DELETE_AFTER_STOP_MINUTES = 240;

let client: Daytona | undefined;
function daytona(): Daytona {
  if (!config.daytona.apiKey) throw new Error("Daytona isn't set up: set DAYTONA_API_KEY.");
  client ??= new Daytona({ apiKey: config.daytona.apiKey, apiUrl: config.daytona.apiUrl, target: config.daytona.target });
  return client;
}

export interface Computer {
  id: string;
  sandbox: Sandbox;
  cpu: number;
  memory: number;
}

interface Row { id: string; sandbox_id: string; status: string; prepared: boolean }

/** The manager's computer, started (and prepared) if needed. `progress` reports the slow steps. */
export async function computerFor(managerId: string, progress: (text: string) => Promise<void>): Promise<Computer> {
  const [row] = await ops<Row>("select id, sandbox_id, status, prepared from ops.computers where manager_id = $1 and status in ('starting', 'ready', 'stopped')", [managerId]);
  if (row) {
    try {
      const sandbox = await daytona().get(row.sandbox_id);
      if (sandbox.state !== "started") {
        await progress("Waking up your computer.");
        await sandbox.start(180);
      }
      await ops("update ops.computers set status = 'ready', last_used_at = now() where id = $1", [row.id]);
      if (!row.prepared) await prepare(row.id, sandbox, progress);
      return { id: row.id, sandbox, cpu: sandbox.cpu, memory: sandbox.memory };
    } catch (error) {
      console.warn("ops: computer gone, starting a new one", (error as Error).message);
      await ops("update ops.computers set status = 'deleted' where id = $1", [row.id]);
    }
  }
  await progress(`Starting a computer (${config.daytona.cpu} CPU, ${config.daytona.memory} GB).`);
  const base = {
    language: "python",
    labels: { app: "trial-ops", manager: managerId },
    envVars: { MPLBACKEND: "Agg", PYTHONUNBUFFERED: "1" },
    autoStopInterval: IDLE_STOP_MINUTES,
    autoDeleteInterval: DELETE_AFTER_STOP_MINUTES,
  };
  const sandbox = config.daytona.snapshot
    ? await daytona().create({ ...base, snapshot: config.daytona.snapshot }, { timeout: 300 })
    : await daytona().create({ ...base, image: config.daytona.image, resources: { cpu: config.daytona.cpu, memory: config.daytona.memory, disk: config.daytona.disk } }, { timeout: 600 });
  const [created] = await ops<{ id: string }>(
    "insert into ops.computers (manager_id, sandbox_id, status, cpu, memory) values ($1, $2, 'ready', $3, $4) returning id",
    [managerId, sandbox.id, sandbox.cpu, sandbox.memory]);
  await prepare(created.id, sandbox, progress);
  return { id: created.id, sandbox, cpu: sandbox.cpu, memory: sandbox.memory };
}

/** Installs the Python data stack once per computer. */
async function prepare(id: string, sandbox: Sandbox, progress: (text: string) => Promise<void>): Promise<void> {
  await progress("Installing the Python data stack.");
  const r = await sandbox.process.executeCommand(`bash -lc 'python -m pip install -q --disable-pip-version-check ${PACKAGES} 2>&1 | tail -5'`, undefined, undefined, 900);
  if (r.exitCode !== 0) throw new Error(`Setting up the computer failed: ${r.result.slice(-400)}`);
  await sandbox.process.executeCommand("mkdir -p data out work");
  await ops("update ops.computers set prepared = true where id = $1", [id]);
}

/** Replaces the computer's data/ folder with a fresh snapshot and clears out/. */
export async function upload(c: Computer, files: { name: string; content: Buffer }[]): Promise<void> {
  await shell(c, "rm -rf data out && mkdir -p data out work");
  await c.sandbox.fs.uploadFiles(files.map((f) => ({ source: f.content, destination: `data/${f.name}` })));
}

export interface RunResult { exitCode: number; output: string }

/** Runs a shell command in the computer's home folder. Long jobs get up to `seconds`. */
export async function shell(c: Computer, command: string, seconds = 600): Promise<RunResult> {
  const r = await c.sandbox.process.executeCommand(`bash -lc '${command.replace(/'/g, `'\\''`)}'`, undefined, undefined, seconds);
  await ops("update ops.computers set last_used_at = now() where id = $1", [c.id]).catch(() => {});
  return { exitCode: r.exitCode, output: r.result ?? "" };
}

/** Writes a Python script to work/ and runs it (so tracebacks have line numbers). */
export async function python(c: Computer, code: string, name: string, seconds = 600): Promise<RunResult> {
  await c.sandbox.fs.uploadFile(Buffer.from(code, "utf8"), `work/${name}`);
  return shell(c, `python work/${name} 2>&1`, seconds);
}

export async function readFile(c: Computer, path: string): Promise<Buffer> {
  return c.sandbox.fs.downloadFile(path, 120);
}

export async function status(managerId: string): Promise<{ status: string; cpu: number | null; memory: number | null; lastUsed: Date } | undefined> {
  const [row] = await ops<{ status: string; cpu: number | null; memory: number | null; last_used_at: Date; sandbox_id: string }>(
    "select status, cpu, memory, last_used_at, sandbox_id from ops.computers where manager_id = $1 order by created_at desc limit 1", [managerId]);
  if (!row) return undefined;
  if (row.status === "ready" || row.status === "stopped") {
    try {
      const sandbox = await daytona().get(row.sandbox_id);
      const now = sandbox.state === "started" ? "ready" : sandbox.state === "stopped" || sandbox.state === "archived" ? "stopped" : row.status;
      if (now !== row.status) await ops("update ops.computers set status = $2 where sandbox_id = $1", [row.sandbox_id, now]);
      return { status: now, cpu: row.cpu, memory: row.memory, lastUsed: row.last_used_at };
    } catch {
      await ops("update ops.computers set status = 'deleted' where sandbox_id = $1", [row.sandbox_id]);
      return { status: "deleted", cpu: row.cpu, memory: row.memory, lastUsed: row.last_used_at };
    }
  }
  return { status: row.status, cpu: row.cpu, memory: row.memory, lastUsed: row.last_used_at };
}

/** Deletes the manager's computer now (its reports stay). */
export async function shutDown(managerId: string): Promise<boolean> {
  const [row] = await ops<{ id: string; sandbox_id: string }>("select id, sandbox_id from ops.computers where manager_id = $1 and status in ('starting', 'ready', 'stopped')", [managerId]);
  if (!row) return false;
  try {
    await (await daytona().get(row.sandbox_id)).delete(120);
  } catch (error) {
    console.warn("ops: deleting the computer", (error as Error).message);
  }
  await ops("update ops.computers set status = 'deleted' where id = $1", [row.id]);
  return true;
}
