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
  port: Number(env("PORT") ?? 3000),
  /** Public base URL of this server; it goes into every card the agent sends. */
  publicUrl: (env("PUBLIC_URL") ?? "http://localhost:3000").replace(/\/+$/, ""),
  dataDir: env("DATA_DIR") ?? ".data",
  /**
   * Our own Swift Messages extension. When set, cards open the native game; otherwise they
   * fall back to the web game inside Photon's Spectrum mini app.
   */
  native: teamId ? ({ teamId, extensionBundleId, appStoreId } satisfies NativeApp) : undefined,
};
