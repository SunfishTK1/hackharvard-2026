import assert from "node:assert/strict";
import { test } from "node:test";
import { opsCard } from "../src/ops/cards.ts";
import { age, VIEWS, when } from "../src/ops/data.ts";
import { opsMessages, opsSystemPrompt } from "../src/ops/prompt.ts";
import type { Entry, Manager } from "../src/ops/store.ts";

const manager: Manager = { id: "m", handle: "+16175550100", displayName: "Jordan Lee", chatMode: "ops" };
const entry = (e: Partial<Entry>): Entry => ({ id: "x", direction: "inbound", author: "manager", kind: "text", body: "", link: null, createdAt: new Date(), ...e });

test("the transcript becomes alternating turns, with updates and cards as notes", () => {
  const turns = opsMessages([
    entry({ author: "agent", direction: "outbound", body: "Earlier reply" }),
    entry({ body: "What needs me today?" }),
    entry({ author: "agent", direction: "outbound", body: "Three alerts." }),
    entry({ author: "agent", direction: "outbound", kind: "card", body: "Alert queue" }),
    entry({ author: "system", kind: "event", body: "An analysis finished." }),
  ]);
  assert.deepEqual(turns.map((t) => t.role), ["user", "assistant", "user"]);
  assert.equal(turns[0].content, "What needs me today?");
  assert.match(turns[2].content, /the "Alert queue" card you sent was delivered/);
  assert.match(turns[2].content, /\[Update: An analysis finished\.\]/);
});

test("a trailing note always ends on the user's side", () => {
  const turns = opsMessages([entry({ body: "Hi" }), entry({ author: "agent", direction: "outbound", body: "Hello." })], "It's time for their morning briefing.");
  assert.equal(turns.at(-1)?.role, "user");
  assert.match(turns.at(-1)!.content, /morning briefing/);
});

test("the prompt names their studies, keeps decisions behind Face ID, and mentions computers only when there are any", () => {
  const plain = opsSystemPrompt(manager, [{ code: "STUDY-005", role: "trial_manager" }]);
  assert.match(plain, /Jordan Lee/);
  assert.match(plain, /STUDY-005 \(trial manager\)/);
  assert.match(plain, /Face ID/);
  assert.doesNotMatch(plain, /start_analysis/);
  assert.match(opsSystemPrompt(manager, [], { computers: true }), /start_analysis/);
});

test("cards carry the view, the link and Trial Ops' art copy", () => {
  const card = opsCard("approvals", "https://example.org/o/abc", { headline: "5 decisions waiting." });
  assert.equal(card.kind, "ops:approvals");
  assert.equal(card.headline, "5 decisions waiting.");
  assert.equal(card.badge, "Face ID");
  assert.equal(card.url, "https://example.org/o/abc");
  assert.ok(card.summary.endsWith("https://example.org/o/abc"));
  for (const view of VIEWS) assert.ok(opsCard(view, "u").headline.endsWith("."), view);
});

test("times read like a person would say them", () => {
  assert.match(when(new Date()), /^Today \d{1,2}:\d{2} (AM|PM)$/);
  assert.match(when(new Date(Date.now() - 86_400_000)), /^Yesterday /);
  assert.match(when(new Date(Date.now() - 40 * 86_400_000)), /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.equal(when(null), "");
  assert.equal(age(new Date(Date.now() - 3.5 * 86_400_000)), 3);
});

test("the loop guard holds a reply after six to one person in a minute, per person", async () => {
  const { LoopGuard } = await import("../src/agent/channel.ts");
  const guard = new LoopGuard("test", 6, 60_000);
  const original = console.error;
  console.error = () => {};
  try {
    const sam = Array.from({ length: 8 }, () => guard.allow("sam"));
    assert.deepEqual(sam, [true, true, true, true, true, true, false, false]);
    assert.equal(guard.allow("thomas"), true);
  } finally {
    console.error = original;
  }
});
