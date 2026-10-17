// Shares the iMessage line with the patient assistant (Patient-AI-Agent). Before answering a text,
// ask its router whether the text is for Sage, the clinical study assistant; if so, stay quiet.
// The router decides each message once (TypeSafe's Jev model, sticky per chat), so both bots act
// on the same decision. Fails open: if the router is down or slow, Charles answers as before.
const ROUTER_URL = process.env.PATIENT_ROUTER_URL ?? "http://patient-assistant:3011/route";

export async function isForPatientAssistant(spaceId: string, handle: string | undefined, text: string): Promise<boolean> {
  if (ROUTER_URL === "off" || !handle || !text) return false;
  try {
    const res = await fetch(ROUTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId, handle, text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const { route } = (await res.json()) as { route?: string };
    return route === "patient_assistant";
  } catch {
    return false;
  }
}
