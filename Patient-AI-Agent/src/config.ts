// Settings, from the environment. Locally they are also read from the repo-root .env,
// Clinical-DB/.env and Patient-AI-Agent/.env (later files win, real environment variables win
// over all), using whichever name each file already has.
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const files = ["../../.env", "../../Clinical-DB/.env", "../.env"].map((p) => new URL(p, import.meta.url));
const fromFiles = files.map((url) => {
  try {
    return parseEnv(readFileSync(url, "utf8"));
  } catch {
    return {};
  }
});
const env: Record<string, string | undefined> = Object.assign({}, ...fromFiles, process.env);

const pick = (...names: string[]): string | undefined => {
  for (const name of names) {
    const value = env[name]?.trim().replace(/^["'“”]+|["'“”]+$/g, "");
    if (value) return value;
  }
  return undefined;
};

function required(label: string, ...names: string[]): string {
  const value = pick(...names);
  if (!value) throw new Error(`Missing ${label}: set ${names[0]}. See Patient-AI-Agent/.env.example.`);
  return value;
}

/**
 * Applies DATABASE_HOST ("host:port", e.g. an SSH tunnel at localhost:15432) and DATABASE_NAME
 * (e.g. a scratch copy) to a connection string, so the same credentials work everywhere.
 */
export function databaseUrl(url: string): string {
  const parsed = new URL(url);
  const host = pick("DATABASE_HOST");
  if (host) parsed.host = host;
  const name = pick("DATABASE_NAME");
  if (name) parsed.pathname = `/${name}`;
  return parsed.toString();
}

const publicUrl = (pick("PUBLIC_URL") ?? "http://localhost:3010").replace(/\/+$/, "");
const nativeTeamId = pick("IMESSAGE_TEAM_ID", "SAGE_TEAM_ID");
const nativeHandles = (pick("NATIVE_CARD_HANDLES") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
const typesafeKey = pick("TYPESAFE_API_KEY", "TypeSafe_AI_API_Key");
const routerMode = (pick("ROUTER") ?? (typesafeKey ? "ai" : pick("ENGAGE_PATTERN") ? "pattern" : "off")) as "ai" | "pattern" | "off";

export const config = {
  /**
   * Postgres URL for the patient_assistant role (row-level scoped to one person per transaction).
   * Deliberately not DATABASE_URL: in Clinical-DB/.env that's the developer role, which bypasses
   * row-level security.
   */
  get databaseUrl() {
    return databaseUrl(required("database URL", "PATIENT_ASSISTANT_DATABASE_URL"));
  },
  /** A role that can act as app_owner, for migrations and the staff demo script. */
  get staffDatabaseUrl() {
    return databaseUrl(required("staff database URL", "STAFF_DATABASE_URL", "DATABASE_URL"));
  },
  get anthropicApiKey() {
    return required("Anthropic API key", "ANTHROPIC_API_KEY", "Anthropic_API_Key");
  },
  model: pick("AGENT_MODEL") ?? "claude-haiku-5-5",
  effort: (pick("AGENT_EFFORT") ?? "low") as "low" | "medium" | "high",
  /** xAI speech: Sage's voice (text to speech) and listening (speech to text). Voice is off without a key. */
  xai: {
    apiKey: pick("XAI_API_KEY", "xAI_API_KEY"),
    voice: pick("SAGE_VOICE") ?? "eve",
    transcribeModel: pick("XAI_TRANSCRIBE_MODEL") ?? "grok-voice-transcribe-2.0",
  },
  /** Spectrum (Photon 1.0) project, where iMessage app cards work. Optional for local console chat. */
  spectrum: {
    projectId: pick("SPECTRUM_PROJECT_ID", "PROJECT_ID", "Phton_10_Project_id", "Photon_10_Project_id"),
    projectSecret: pick("SPECTRUM_PROJECT_SECRET", "PROJECT_SECRET", "Photon_10_Project_secret"),
  },
  /**
   * Sharing a Spectrum line with other bots. "ai": TypeSafe's Jev model decides, per message,
   * whether it is for the patient assistant. "pattern": only first texts matching ENGAGE_PATTERN
   * start a conversation. "off": answer everything.
   */
  router: {
    mode: routerMode,
    typesafeApiKey: typesafeKey,
    model: pick("ROUTER_MODEL") ?? "jev-latest",
    engagePattern: pick("ENGAGE_PATTERN") ? new RegExp(pick("ENGAGE_PATTERN")!, "i") : undefined,
    /** Internal-only port where other bots on the line ask who answers a message. */
    port: Number(pick("ROUTER_PORT") ?? 3011),
  },
  /**
   * The Sage iOS app (Patient-AI-Agent/ios). Cards for these handles open its Messages extension,
   * which shows the same mini-apps with native Face ID; everyone else gets web cards. "*" = all.
   */
  native: nativeTeamId && nativeHandles.length
    ? {
        teamId: nativeTeamId,
        extensionBundleId: pick("IMESSAGE_EXTENSION_BUNDLE_ID") ?? "com.velroi.sage.MessagesExtension",
        appName: "Sage",
        handles: nativeHandles,
      }
    : undefined,
  /** The study new contacts are screened for (study_code). Unset: the most recently updated active study. */
  defaultStudyCode: pick("DEFAULT_STUDY", "DEFAULT_TRIAL"),
  port: Number(pick("PORT") ?? 3010),
  /** Public base URL for mini-app links. Its host is also the passkey (Face ID) relying party. */
  publicUrl,
  rpId: new URL(publicUrl).hostname,
  /** Used for people and for sites whose time zone is unset (the platform defaults sites to UTC). */
  timeZone: pick("TIMEZONE") ?? "America/New_York",
  assistantName: pick("ASSISTANT_NAME") ?? "Sage",
};

export type Config = typeof config;
