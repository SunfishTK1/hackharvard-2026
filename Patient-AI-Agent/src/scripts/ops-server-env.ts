// Prints a shell script that sets Trial Ops' secrets on the server, for piping straight into ssh so
// no secret is shown on screen:
//   node Patient-AI-Agent/src/scripts/ops-server-env.ts | ssh root@<server> bash
// It (re)writes, in /opt/apps/patient-assistant/.env: TRIAL_OPS_DATABASE_URL (the manager_agent login
// from your local env files, pointed at Postgres on the Docker network), TRIAL_OPS_SPECTRUM_PROJECT_ID
// and _SECRET (from the photon CLI), TRIAL_OPS_API_TOKEN (new, random) and DAYTONA_API_KEY; and in
// /opt/apps/ops-home/.env the API URL and the same token. Existing values for those names are replaced.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { config } from "../config.ts";

const PROJECT = process.argv[2] ?? "b20be7b3-1c05-43ce-8a34-cc6c2a442ac9";
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const local = config.ops.databaseUrl ?? fail("No manager_agent login in your local env files (TRIAL_OPS_DATABASE_URL or MANAGER_AGENT_DATABASE_URL).");
const db = new URL(local);
if (decodeURIComponent(db.username) !== "manager_agent") fail(`The Trial Ops login should be manager_agent, not ${db.username}.`);
db.host = "clinical-db-postgres-1:5432";
db.pathname = "/clinical_trials";
db.search = "";
const daytona = config.daytona.apiKey ?? fail("No DAYTONA_API_KEY in your local env files.");
const secret = (() => {
  const out = execFileSync("photon", ["projects", "secret", PROJECT, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return (JSON.parse(out) as { projectSecret?: string }).projectSecret ?? fail("photon didn't return the project secret.");
})();
const token = randomBytes(32).toString("hex");

const set = (file: string, values: Record<string, string>) => {
  const names = Object.keys(values).map((n) => `^${n}=`).join("|");
  return [
    `touch ${file} && chmod 600 ${file}`,
    `grep -Ev '${names}' ${file} > ${file}.new || true`,
    `cat >> ${file}.new <<'TRIAL_OPS_EOF'`,
    ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
    "TRIAL_OPS_EOF",
    `chmod 600 ${file}.new && mv ${file}.new ${file}`,
  ].join("\n");
};

process.stdout.write(`set -e
${set("/opt/apps/patient-assistant/.env", {
  TRIAL_OPS_DATABASE_URL: db.toString(),
  TRIAL_OPS_SPECTRUM_PROJECT_ID: PROJECT,
  TRIAL_OPS_SPECTRUM_PROJECT_SECRET: secret,
  TRIAL_OPS_API_TOKEN: token,
  DAYTONA_API_KEY: daytona,
})}
${set("/opt/apps/ops-home/.env", { TRIAL_OPS_API_URL: "http://patient-assistant:3012", TRIAL_OPS_API_TOKEN: token })}
echo "Trial Ops settings written to /opt/apps/patient-assistant/.env and /opt/apps/ops-home/.env (values not shown)."
`);
