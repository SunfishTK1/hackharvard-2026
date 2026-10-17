import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

// Settings come from three places. Later sources win:
//   1. the hackathon repo's root .env (../.env), which uses its own variable names
//   2. Photon-Demo/.env
//   3. real environment variables
const sources = [new URL("../../.env", import.meta.url), new URL("../.env", import.meta.url)];

function readEnvFile(url: URL): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(url, "utf8"));
  } catch {
    return {};
  }
}

const env: Record<string, string | undefined> = Object.assign(
  {},
  ...sources.map(readEnvFile),
  process.env,
);

/** First non-empty value among `names`, so both naming styles work. */
function pick(...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export type Config = {
  photonApiKey: string;
  photonProjectId: string;
  anthropicApiKey: string;
  model: string;
  effort: Effort;
  /** iMessage handles (E.164 phone or Apple ID email) allowed to talk to the agent; empty means anyone. */
  allowedSenders: string[];
  /** How many earlier messages in the conversation to give the model. */
  historyLimit: number;
  /** Time zone the agent assumes for "remind me at 5pm" and similar. */
  timeZone: string;
  /** Effort for writing mini-apps; higher is slower but more polished. */
  miniAppEffort: Effort;
  /** Port of the built-in web server that hosts mini-apps. */
  port: number;
  /** Public base URL of that web server, used in the links the agent texts. */
  miniAppsUrl: string;
  /** Replay cursor, reminders and mini-apps live here. */
  dataDir: URL;
  cursorFile: URL;
};

export function loadConfig(): Config {
  const required = {
    photonApiKey: { value: pick("PHOTON_API_KEY", "photon_20_beta_key"), names: "PHOTON_API_KEY (or photon_20_beta_key)" },
    photonProjectId: { value: pick("PHOTON_PROJECT_ID", "photon_project_id"), names: "PHOTON_PROJECT_ID (or photon_project_id)" },
    anthropicApiKey: { value: pick("ANTHROPIC_API_KEY", "Anthropic_API_Key"), names: "ANTHROPIC_API_KEY (or Anthropic_API_Key)" },
  };
  const missing = Object.values(required).filter((r) => !r.value).map((r) => r.names);
  if (missing.length) throw new Error(`Missing settings: ${missing.join(", ")}. See Photon-Demo/.env.example.`);

  const effortSetting = (name: string, fallback: Effort): Effort => {
    const value = pick(name) ?? fallback;
    if (!(EFFORTS as readonly string[]).includes(value)) throw new Error(`${name} must be one of ${EFFORTS.join(", ")}.`);
    return value as Effort;
  };

  const historyLimit = Number(pick("HISTORY_LIMIT") ?? 20);
  if (!Number.isInteger(historyLimit) || historyLimit < 0 || historyLimit > 200) throw new Error("HISTORY_LIMIT must be an integer from 0 to 200.");

  const timeZone = pick("TIMEZONE") ?? "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`TIMEZONE "${timeZone}" isn't a valid IANA time zone, like America/New_York.`);
  }

  const port = Number(pick("PORT") ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a port number.");

  const dataDir = new URL("../.data/", import.meta.url);
  return {
    photonApiKey: required.photonApiKey.value!,
    photonProjectId: required.photonProjectId.value!,
    anthropicApiKey: required.anthropicApiKey.value!,
    model: pick("AGENT_MODEL") ?? "claude-haiku-5-5",
    effort: effortSetting("AGENT_EFFORT", "low"),
    allowedSenders: (pick("ALLOWED_SENDERS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    historyLimit,
    timeZone,
    miniAppEffort: effortSetting("MINI_APP_EFFORT", "medium"),
    port,
    miniAppsUrl: (pick("MINI_APPS_URL") ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    dataDir,
    cursorFile: new URL("cursor.json", dataDir),
  };
}

/** Optional settings used only by the setup scripts. */
export function setting(...names: string[]): string | undefined {
  return pick(...names);
}
