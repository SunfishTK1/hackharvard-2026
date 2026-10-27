import { createServer, type IncomingMessage } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { parseEnv } from "node:util";
import pg from "pg";

const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = join(process.cwd(), "dist");
const MODEL_ID = "claude-haiku-5-5";

function loadEnvVars(): Record<string, string | undefined> {
  const candidates = [
    join(process.cwd(), "../.env"),
    join(process.cwd(), "../Clinical-DB/.env"),
    join(process.cwd(), ".env"),
  ];
  const merged: Record<string, string | undefined> = {};
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        const parsed = parseEnv(readFileSync(file, "utf8"));
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") {
            merged[k] = v.replace(/^["“”']+|["“”']+$/g, "").trim();
          }
        }
      }
    } catch {
      // Ignore unreadable env file
    }
  }
  return { ...merged, ...process.env };
}

const env = loadEnvVars();
const anthropicApiKey = (env.ANTHROPIC_API_KEY ?? env.Anthropic_API_Key ?? "").replace(
  /^["“”']+|["“”']+$/g,
  ""
).trim();
const rawDbUrl = (
  env.ANALYST_DATABASE_URL ??
  env.MANAGER_AGENT_DATABASE_URL ??
  env.DATABASE_URL ??
  ""
).replace(/^["“”']+|["“”']+$/g, "").trim();

const databaseUrl = rawDbUrl
  ? rawDbUrl
      .replace(/@[^:/]+:5432\//, "@clinical-db-postgres-1:5432/")
      .replace(/[?&]sslmode=[^&]+/g, "")
  : "";

const pool = databaseUrl
  ? new pg.Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 3500,
      max: 4,
    })
  : null;

async function fetchDatabaseContext(): Promise<string> {
  if (!pool) return "No live database connected; synthesize realistic clinical trial data.";
  try {
    const [trials, enrollment, participants, adverseEvents, sourceCoverage] =
      await Promise.all([
        pool.query(
          `SELECT trial_code, title, phase, status, therapeutic_area, intervention, primary_endpoint, enrolled, target_enrollment, active, withdrawn, screening, open_adverse_events, serious_adverse_events, open_alerts, observations_7d FROM analytics.trials ORDER BY trial_code`
        ),
        pool.query(
          `SELECT trial_code, arm_code, arm_name, is_control, target_enrollment, enrolled, active, completed, withdrawn FROM analytics.enrollment ORDER BY trial_code, arm_code`
        ),
        pool.query(
          `SELECT trial_code, subject_code, arm_code, site_code, status, sex, birth_year, study_day, messages_from_patient_7d, check_ins_14d, check_ins_answered_14d, check_in_response_rate_14d, observations_7d, open_adverse_events, max_adverse_event_grade FROM analytics.participants ORDER BY trial_code, subject_code`
        ),
        pool.query(
          `SELECT trial_code, subject_code, arm_code, term, grade, is_serious, relatedness, action_taken, outcome, status, days_to_resolution, reported_via FROM analytics.adverse_events ORDER BY onset_at DESC`
        ),
        pool.query(
          `SELECT trial_code, source_code, source_kind, observations, participants, measures FROM analytics.source_coverage ORDER BY trial_code, observations DESC`
        ),
      ]);

    return JSON.stringify({
      trials: trials.rows,
      enrollment: enrollment.rows,
      participants: participants.rows,
      adverse_events: adverseEvents.rows,
      source_coverage: sourceCoverage.rows,
    });
  } catch (err) {
    console.error("DB context fallback:", err instanceof Error ? err.message : err);
    return "Database unreachable right now; synthesize realistic clinical trial data.";
  }
}

export interface AgentTableResponse {
  title: string;
  subtitle: string;
  summary: string;
  model: string;
  sourceLabel: string;
  metrics: Array<{ label: string; value: string; sub?: string }>;
  columns: Array<{
    key: string;
    label: string;
    align?: "left" | "center" | "right";
    emphasis?: "code" | "badge" | "metric" | "normal";
  }>;
  rows: Array<Record<string, string | number | boolean | null>>;
}

const SYSTEM_PROMPT = `You are the Prod Trial Manager AI Agent (running on Claude Haiku 5.5).
Whenever the Trial Manager sends an instruction or question, you respond with ONE JSON object that renders a clean, high-contrast, easy-to-read data table on the center screen.

Reply with ONLY valid JSON (no Markdown code fences, no commentary before or after) matching this exact schema:
{
  "title": "UPPERCASE TABLE TITLE (concise, e.g. NORTHSTAR-2 · PARTICIPANT ADHERENCE ROSTER)",
  "subtitle": "Short context line describing scope or filter applied",
  "summary": "1-2 crisp sentences of clinical trial manager insight highlighting key findings or anomalies in the table.",
  "sourceLabel": "LIVE CLINICAL-DB · ANALYTICS" or "PROD AGENT SYNTHESIS",
  "metrics": [
    { "label": "SHORT KPI LABEL", "value": "PRIMARY VALUE", "sub": "Short context" }
  ],
  "columns": [
    {
      "key": "column_key",
      "label": "READABLE HEADER",
      "align": "left" | "center" | "right",
      "emphasis": "code" | "badge" | "metric" | "normal"
    }
  ],
  "rows": [
    { "column_key": "Formatted readable value" }
  ]
}

Design & readability rules:
1. Keep between 4 and 7 columns so the table is effortless to scan on screen.
2. Use "emphasis": "code" for IDs/codes (like subject_code NS2-001, trial_code NORTHSTAR-2, arm_code), "badge" for statuses/grades/flags (like ACTIVE, GRADE 3, OPEN, SERIOUS, LOW ADHERENCE), "metric" for numbers/percentages/rates (align "right"), and "normal" for text.
3. Format all cell values cleanly for humans (e.g., "86%" instead of "0.86", "Day 24" or "24d", "Grade 2", "None" instead of null).
4. Include 3 to 4 summary items in "metrics" at the top of the table.
5. Use the live clinical trial database snapshot whenever the prompt relates to trials, participants, adherence, arms, enrollment, observations, or adverse events. If the user asks for something outside the snapshot, synthesize a realistic, comprehensive clinical trial table that directly fulfills their prompt.`;

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenceStripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const firstBrace = fenceStripped.indexOf("{");
  const lastBrace = fenceStripped.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(fenceStripped.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
  }
  return JSON.parse(fenceStripped) as Record<string, unknown>;
}

async function generateAgentTable(prompt: string): Promise<AgentTableResponse> {
  const dbSnapshot = await fetchDatabaseContext();

  if (!anthropicApiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY in server environment.");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL_ID,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Live Clinical-DB Snapshot:\n${dbSnapshot}\n\nTrial Manager Request:\n${prompt}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude Haiku 5.5 API error (${response.status}): ${errText}`);
  }

  const data = (await response.json()) as {
    model?: string;
    content?: Array<{ type: string; text?: string }>;
  };

  const textBlock = (data.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");

  const parsed = extractJsonObject(textBlock);

  return {
    title: String(parsed.title ?? "CLINICAL TRIAL DATA VIEW"),
    subtitle: String(parsed.subtitle ?? `Generated for: "${prompt}"`),
    summary: String(parsed.summary ?? ""),
    model: data.model ?? MODEL_ID,
    sourceLabel: String(parsed.sourceLabel ?? "LIVE CLINICAL-DB · HAIKU 5.5"),
    metrics: Array.isArray(parsed.metrics)
      ? (parsed.metrics as AgentTableResponse["metrics"])
      : [],
    columns: Array.isArray(parsed.columns)
      ? (parsed.columns as AgentTableResponse["columns"])
      : [],
    rows: Array.isArray(parsed.rows)
      ? (parsed.rows as AgentTableResponse["rows"])
      : [],
  };
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const urlPath = (req.url ?? "/").split("?")[0] || "/";

  if (urlPath === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: MODEL_ID }));
    return;
  }

  if (urlPath === "/api/agent/table" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Please enter a prompt." }));
        return;
      }

      const tableResult = await generateAgentTable(prompt);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(tableResult));
    } catch (err) {
      console.error("Agent error:", err);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          error: err instanceof Error ? err.message : "Failed to generate table",
        })
      );
    }
    return;
  }

  const safeSuffix = normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(DIST_DIR, safeSuffix === "/" ? "index.html" : safeSuffix);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(DIST_DIR, "index.html");
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`clinical-trial-manager-view (${MODEL_ID}) listening on http://0.0.0.0:${PORT}`);
});
