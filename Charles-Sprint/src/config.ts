// All settings come from the environment (.env locally, /opt/apps/charles-sprint/.env on the server).

const env = (name: string) => process.env[name]?.trim() || undefined;

export interface NativeApp {
  /** Apple Developer Team ID that signs the iOS app (10 characters). */
  teamId: string;
  /** Bundle ID of the Messages extension inside the iOS app. */
  extensionBundleId: string;
  /** App Store ID, once published. Recipients without the app are pointed there. */
  appStoreId?: number;
}

const teamId = env("IMESSAGE_TEAM_ID");
const extensionBundleId = env("IMESSAGE_EXTENSION_BUNDLE_ID") ?? "com.velroi.charlessprint.MessagesExtension";
const appStoreId = Number(env("IMESSAGE_APP_STORE_ID")) || undefined;

export const config = {
  projectId: env("PROJECT_ID"),
  projectSecret: env("PROJECT_SECRET"),
  /** Claude writes LastLight's replies. Without a key it falls back to fixed replies and stock jokes. */
  anthropicApiKey: env("ANTHROPIC_API_KEY") ?? env("Anthropic_API_Key"),
  /** xAI makes LastLight's meme pictures, meme videos and voice notes. Without it there are none. */
  xaiApiKey: env("XAI_API_KEY") ?? env("xAI_API_KEY"),
  port: Number(env("PORT") ?? 3000),
  /** Localhost-only control port used by src/scripts/send-card.ts. */
  adminPort: Number(env("ADMIN_PORT") ?? 3001),
  /** Public base URL of this server; it goes into every card the agent sends. */
  publicUrl: (env("PUBLIC_URL") ?? "http://localhost:3000").replace(/\/+$/, ""),
  dataDir: env("DATA_DIR") ?? ".data",
  /** Line number for LastLight's contact card when the per-user lookup has no answer. */
  imessageLine: env("IMESSAGE_LINE"),
  /**
   * Our own Swift Messages extension. When set, cards open the native game; otherwise they
   * fall back to the web game inside Photon's Spectrum mini app.
   */
  native: teamId ? ({ teamId, extensionBundleId, appStoreId } satisfies NativeApp) : undefined,
};
