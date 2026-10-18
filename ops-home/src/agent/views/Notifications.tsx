// What Trial Ops texts about on its own (alerts by severity, a morning briefing), and Face ID sign-in
// for this site.
import { useEffect, useState } from "react";
import { call } from "../api";
import { useWorkspace } from "../core";
import { addSignInPasskey, passkeysSupported } from "../faceid";
import type { Prefs } from "../types";
import { Card, Header, Segmented } from "../ui";

export function NotificationsView() {
  const ws = useWorkspace();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void call<Prefs>("prefs").then((r) => (r.ok ? setPrefs(r.body) : setError(r.body.error ?? "Your settings couldn't load.")));
  }, []);
  const save = async (change: Partial<Prefs>) => {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, ...change });
    const r = await call<Prefs>("prefs", { body: change });
    if (r.ok) { setPrefs(r.body); ws.toast("Saved."); } else { setPrefs(previous); setError(r.body.error ?? "That couldn't be saved."); }
  };
  const briefingOn = prefs ? prefs.briefing !== "off" : false;
  const [faceId, setFaceId] = useState<{ on: boolean; busy: boolean; error?: string }>({ on: Boolean(ws.me.faceIdSignIn), busy: false });
  const setUpFaceId = async () => {
    setFaceId((f) => ({ ...f, busy: true, error: undefined }));
    try {
      await addSignInPasskey();
      setFaceId({ on: true, busy: false });
      ws.toast("Face ID sign-in is on for this device.");
    } catch (err) {
      setFaceId((f) => ({ ...f, busy: false, error: err instanceof Error ? err.message : "Face ID couldn't be set up." }));
    }
  };
  return (
    <>
      <Header eyebrow="Notifications" title="What Trial Ops texts you." lede="Alerts as they're raised and a morning briefing, in your iMessage chat with Trial Ops. They also show up here." />
      {error && <p className="decision-error" role="alert">{error}</p>}
      {prefs && (
        <>
          <Card className="space">
            <h2>New alerts</h2>
            <div className="gap"><Segmented label="New alerts" value={prefs.alerts} onChange={(v) => save({ alerts: v })} options={[
              { value: "all", label: "All" }, { value: "high", label: "High and up" }, { value: "critical", label: "Critical" }, { value: "off", label: "Off" },
            ]} /></div>
            <p className="pref-note">{prefs.alerts === "off" ? "No alert texts. You'll still see them here." : prefs.alerts === "all" ? "Every new alert in your studies." : prefs.alerts === "high" ? "High and critical alerts, and every case Sage escalates." : "Only critical alerts, and every case Sage escalates."}</p>
          </Card>
          <Card>
            <div className="pref-row">
              <span className="text"><b>Morning briefing</b><small>Today's decisions, high alerts and who's stuck.</small></span>
              <button type="button" className="switch" role="switch" aria-checked={briefingOn} aria-label="Morning briefing"
                onClick={() => save({ briefing: briefingOn ? "off" : "08:00" })}><span className="knob" /></button>
            </div>
            {briefingOn && (
              <div className="pref-row gap">
                <label className="text" htmlFor="briefing-time"><b>Time</b><small>{prefs.timeZone ?? "Your time zone"}</small></label>
                <input id="briefing-time" className="field time" type="time" value={prefs.briefing} onChange={(e) => e.target.value && save({ briefing: e.target.value })} />
              </div>
            )}
          </Card>
        </>
      )}
      {passkeysSupported() && (
        <Card className="space">
          <div className="pref-row">
            <span className="text"><b>Sign in with Face ID</b><small>{faceId.on ? "On. Add this device too if you sign in from more than one." : "Skip the texted link: sign in to this site with Face ID or Touch ID."}</small></span>
            <button type="button" className={`btn${faceId.on ? " soft" : ""}`} disabled={faceId.busy} onClick={() => void setUpFaceId()}>
              {faceId.busy ? "Waiting for Face ID…" : faceId.on ? "Add this device" : "Turn on"}
            </button>
          </div>
          {faceId.error && <p className="decision-error" role="alert">{faceId.error}</p>}
        </Card>
      )}
    </>
  );
}
