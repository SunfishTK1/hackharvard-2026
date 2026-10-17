import { ApiError, Photon } from "@photon-ai/api";
import type { ImessageMessageContent, ImessageSpaceSnapshot, ImessageUserSnapshot, Message, ReceivedImessageMessage } from "@photon-ai/api";

export type Turn = { role: "user" | "assistant"; text: string };

/** An iMessage a person sent to the agent, with the fields the agent needs already narrowed. */
export type Inbound = {
  message: ReceivedImessageMessage;
  sender: ImessageUserSnapshot;
  agent: ImessageUserSnapshot;
  space: ImessageSpaceSnapshot;
  text: string;
};

export function createPhoton(apiKey: string): Photon {
  return new Photon({ headers: { Authorization: `Bearer ${apiKey}` } });
}

/** Readable text from iMessage content, or "" for typing indicators, read receipts and the like. */
export function textOf(content: ImessageMessageContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "attachment":
      return "[sent an attachment]";
    case "group":
      return content.parts
        .map((part) => (part.type === "text" ? part.text : part.type === "attachment" ? "[sent an attachment]" : ""))
        .filter(Boolean)
        .join("\n");
    default:
      return "";
  }
}

/**
 * The inbound message in a `message.received` event, or undefined when there is
 * nothing to answer: other platforms, the agent's own messages, group chats,
 * typing indicators and read receipts.
 */
export function inboundImessage(object: unknown): Inbound | undefined {
  const m = object as Message | undefined;
  if (!m || m.platform !== "imessage" || m.status !== "received") return undefined;
  const { sentBy: sender, receivedBy: agent, space } = m;
  if (sender.platform !== "imessage" || sender.kind !== "human") return undefined;
  if (agent?.platform !== "imessage" || agent.kind !== "agent") return undefined;
  // One-on-one chats only. Shared lines can't join group chats, and an agent
  // answering every message in a group gets noisy fast.
  if (space.platform !== "imessage" || space.kind !== "direct") return undefined;
  const text = textOf(m.content).trim();
  return text ? { message: m, sender, agent, space, text } : undefined;
}

/**
 * The conversation leading up to `incoming`, oldest first, read back from Photon.
 * Photon stores every message, so the agent keeps no chat state of its own.
 */
export async function conversationBefore(
  photon: Photon,
  projectId: string,
  incoming: Inbound,
  limit: number,
): Promise<Turn[]> {
  if (limit === 0) return [];
  const agentId = incoming.agent.id;
  const page = await photon.projects.listMessages({
    path: { id: projectId },
    query: { spaceId: incoming.space.id, perspectiveUserId: agentId, order: "desc", pageSize: limit + 1 },
  });
  const cutoff = Date.parse(incoming.message.createdAt);
  const turns: Turn[] = [];
  for (const m of page.items.toReversed()) {
    if (m.platform !== "imessage" || m.id === incoming.message.id || Date.parse(m.createdAt) > cutoff) continue;
    const text = textOf(m.content).trim();
    if (!text) continue;
    turns.push({ role: m.sentBy.platform === "imessage" && m.sentBy.id === agentId ? "assistant" : "user", text });
  }
  return turns.slice(-limit);
}

type Destination = { spaceId: string; senderId: string };

export async function sendText(
  photon: Photon,
  projectId: string,
  to: Destination,
  text: string,
  idempotencyKey: string,
): Promise<void> {
  await photon.projects.sendMessage({
    path: { id: projectId },
    // The same key on a retry or a replayed event never sends the reply twice.
    headers: { "idempotency-key": idempotencyKey },
    body: { ...to, content: { type: "text", format: "plain", text } },
  });
}

/** Shows or hides the typing bubble. Best effort: a failed typing update never blocks a reply. */
export async function setTyping(photon: Photon, projectId: string, to: Destination, typing: boolean): Promise<void> {
  try {
    await photon.projects.setSpaceTyping({
      path: { id: projectId, spaceId: to.spaceId },
      body: { senderId: to.senderId, typing },
    });
  } catch (error) {
    console.warn(`Typing update failed: ${describePhotonError(error)}`);
  }
}

export function describePhotonError(error: unknown): string {
  if (error instanceof ApiError) return `Photon API ${error.status}: ${error.message} (request ${error.requestId ?? "unknown"})`;
  return error instanceof Error ? error.message : String(error);
}
