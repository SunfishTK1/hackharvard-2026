// Trial Ops, the trial manager's agent, as one module another app can use. Three ways in:
// 1. HTTP: the internal API (api.ts) that the ops website's Agentic mode calls server-to-server.
// 2. Links: mini-app URLs (core.link) open any view, including Face ID decisions, in a browser.
// 3. Code: import from here and drive the same pieces directly (same database role and settings).
//
//   import { OpsCore, data, ops, store } from "./ops/index.ts";
//   const core = new OpsCore();                                 // the model, tools and analyst
//   const m = await store.managerByHandle(ops, "+16175550123");
//   const turn = await core.chat(m!, "What needs my attention today?");   // { text, links }
//   const home = await data.home(ops);                          // the portfolio view model
export { OpsAgent } from "./agent.ts";
export { Analyst, type AnalysisDone } from "./analyst.ts";
export * as approvals from "./approvals.ts";
export { startOpsApi } from "./api.ts";
export { opsCard } from "./cards.ts";
export * as computer from "./computer.ts";
export { OpsCore, VIEW_TITLES, type OpsLink, type OpsTurn } from "./core.ts";
export * as data from "./data.ts";
export { closeOps, ops, opsEnabled, opsTx } from "./db.ts";
export { snapshot } from "./export.ts";
export { opsMessages, opsSystemPrompt } from "./prompt.ts";
export * as store from "./store.ts";
export { opsTools } from "./tools.ts";
export { viewJson } from "./views.ts";
export { opsHttp } from "./web.ts";
