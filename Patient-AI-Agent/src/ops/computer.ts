// A Daytona computer for a manager's analyses: one cloud sandbox each, created on first use with the
// Python data stack, stopped by Daytona when idle and deleted a while after. It holds only the data
// snapshot an analysis uploads (export.ts): no database access, credentials or API keys.
import type { Daytona, Sandbox } from "@daytona/sdk";
import { config } from "../config.ts";
import { ops } from "./db.ts";

export const computersEnabled = () => Boolean(config.daytona.apiKey);

const PACKAGES = "pandas numpy scipy statsmodels matplotlib seaborn scikit-learn lifelines pyarrow openpyxl tabulate";
const IDLE_STOP_MINUTES = 30;
const DELETE_AFTER_STOP_MINUTES = 240;

let client: Promise<Daytona> | undefined;
/** The Daytona client, loaded on first use: the SDK is large, and most hours nobody runs an analysis. */
function daytona(): Promise<Daytona> {
  if (!config.daytona.apiKey) throw new Error("Daytona isn't set up: set DAYTONA_API_KEY.");
  client ??= import("@daytona/sdk").then(({ Daytona }) => new Daytona({ apiKey: config.daytona.apiKey, apiUrl: config.daytona.apiUrl, target: config.daytona.target }));
  return client;
}

export type Machine = "standard" | "large" | "gpu";
export const MACHINES: Machine[] = ["standard", "large", "gpu"];

export interface Computer {
  id: string;
  sandbox: Sandbox;
  cpu: number;
  memory: number;
  gpu: number;
  machine: Machine;
}

interface Row { id: string; sandbox_id: string; status: string; prepared: boolean; machine: Machine }

interface Size { cpu: number; memory: number; disk: number; gpu: number; gpuType?: string }
const SIZE = (m: Machine): Size =>
  m === "gpu" ? config.daytona.gpu
  : m === "large" ? { ...config.daytona.large, gpu: 0 }
  : { cpu: config.daytona.cpu, memory: config.daytona.memory, disk: config.daytona.disk, gpu: 0 };
const label = (m: Machine) => {
  const s = SIZE(m);
  return `${s.gpu ? `${s.gpu} GPU, ` : ""}${s.cpu} CPU, ${s.memory} GB`;
};

/**
 * The manager's computer of this size, started (and prepared) if needed; one of another size is
 * replaced. `progress` reports the slow steps.
 */
export async function computerFor(managerId: string, progress: (text: string) => Promise<void>, machine: Machine = "standard"): Promise<Computer> {
  let [row] = await ops<Row>("select id, sandbox_id, status, prepared, machine from ops.computers where manager_id = $1 and status in ('starting', 'ready', 'stopped')", [managerId]);
  if (row && row.machine !== machine) {
    await progress(`Swapping your ${row.machine} computer for a ${machine === "gpu" ? "GPU" : machine} one.`);
    await shutDown(managerId);
    row = undefined as never;
  }
  if (row) {
    try {
      const sandbox = await (await daytona()).get(row.sandbox_id);
      if (sandbox.state !== "started") {
        await progress("Waking up your computer.");
        await sandbox.start(180);
      }
      await ops("update ops.computers set status = 'ready', last_used_at = now() where id = $1", [row.id]);
      if (!row.prepared) await prepare(row.id, sandbox, progress);
      return { id: row.id, sandbox, cpu: sandbox.cpu, memory: sandbox.memory, gpu: sandbox.gpu ?? 0, machine };
    } catch (error) {
      console.warn("ops: computer gone, starting a new one", (error as Error).message);
      await ops("update ops.computers set status = 'deleted' where id = $1", [row.id]);
    }
  }
  await progress(`Starting a ${machine === "gpu" ? "GPU" : machine} computer (${label(machine)}).`);
  const base = {
    language: "python",
    labels: { app: "trial-ops", manager: managerId },
    envVars: { MPLBACKEND: "Agg", PYTHONUNBUFFERED: "1" },
    autoStopInterval: IDLE_STOP_MINUTES,
    // Daytona only runs GPU computers as ephemeral ones: deleted as soon as they stop.
    autoDeleteInterval: machine === "gpu" ? 0 : DELETE_AFTER_STOP_MINUTES,
  };
  const size = SIZE(machine);
  let sandbox: Sandbox;
  try {
    sandbox = config.daytona.snapshot && machine === "standard"
      ? await (await daytona()).create({ ...base, snapshot: config.daytona.snapshot }, { timeout: 300 })
      : await (await daytona()).create({
          ...base, image: config.daytona.image,
          resources: { cpu: size.cpu, memory: size.memory, disk: size.disk, ...(size.gpu ? { gpu: size.gpu, ...(size.gpuType ? { gpuType: size.gpuType as never } : {}) } : {}) },
        }, { timeout: 600 });
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    if (machine === "gpu") {
      const credits = /credit|wallet/i.test(message) ? " The Daytona account needs GPU credits (its Wallet page)." : "";
      throw new Error(`Daytona couldn't start a GPU computer: ${message.replace(/\.$/, "")}.${credits} A standard or large computer works meanwhile.`);
    }
    throw error;
  }
  const [created] = await ops<{ id: string }>(
    "insert into ops.computers (manager_id, sandbox_id, status, cpu, memory, gpu, machine) values ($1, $2, 'ready', $3, $4, $5, $6) returning id",
    [managerId, sandbox.id, sandbox.cpu, sandbox.memory, sandbox.gpu ?? 0, machine]);
  await prepare(created.id, sandbox, progress);
  return { id: created.id, sandbox, cpu: sandbox.cpu, memory: sandbox.memory, gpu: sandbox.gpu ?? 0, machine };
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
      const sandbox = await (await daytona()).get(row.sandbox_id);
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
    await (await (await daytona()).get(row.sandbox_id)).delete(120);
  } catch (error) {
    console.warn("ops: deleting the computer", (error as Error).message);
  }
  await ops("update ops.computers set status = 'deleted' where id = $1", [row.id]);
  return true;
}
