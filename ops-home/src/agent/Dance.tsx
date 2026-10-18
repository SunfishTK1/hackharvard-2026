// The dancing crab, an easter egg. Ask Trial Ops to dance and it sends the crab (the same one it
// texts as a GIF), which shows up in the chat as a little disco tile and dances all over the screen.
// The sprite sheet comes from Patient-AI-Agent/src/scripts/make-dance.ts: 16 frames in a row.
import { useEffect, useRef } from "react";
import type { AgentLink } from "../agent-types";
import sheet from "./crab-sheet.png";

export const isDance = (link: AgentLink) => link.view === "dance";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The crab doing its two-second loop. Width sets the size; frames are 224 x 160. */
export function Crab({ width }: { width: number }) {
  return <span className="crab" style={{ width, height: (width * 160) / 224, backgroundImage: `url(${sheet})` }} aria-hidden="true" />;
}

/** The crab as it appears in the chat. Tapping it sets it dancing again. */
export function CrabTile({ onDance }: { onDance: () => void }) {
  return (
    <button type="button" className="crab-tile" onClick={onDance} aria-label="The dancing crab. Play it again">
      <Crab width={112} />
      <span className="crab-floor" aria-hidden="true" />
    </button>
  );
}

const NOTES = ["♪", "♫", "♪", "♬", "♫", "♪"];

/** The crab hops between spots all over the screen for about nine seconds, then dances off. */
export function DanceParty({ onDone }: { onDone: () => void }) {
  const mover = useRef<HTMLDivElement>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const end = () => done.current();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") end(); };
    window.addEventListener("keydown", onKey);
    const el = mover.current;
    if (!el || reducedMotion()) {
      const t = setTimeout(end, 3500);
      return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); };
    }
    const size = el.getBoundingClientRect();
    const w = Math.max(0, innerWidth - size.width);
    const h = Math.max(0, innerHeight - size.height);
    const spot = (i: number) => ({ x: Math.round(w * (0.1 + 0.8 * Math.random())), y: Math.round(h * (i % 2 ? 0.15 + 0.3 * Math.random() : 0.55 + 0.35 * Math.random())) });
    // In from the left, eight spots around the screen, out to the right.
    const path = [{ x: -size.width, y: Math.round(h * 0.7) }, ...Array.from({ length: 8 }, (_, i) => spot(i)), { x: innerWidth + 20, y: Math.round(h * 0.6) }];
    const keyframes = path.map((p, i) => {
      const facing = i > 0 && p.x < path[i - 1].x ? -1 : 1;
      return { transform: `translate(${p.x}px, ${p.y}px) rotate(${i % 2 ? -7 : 7}deg) scaleX(${facing})`, offset: i / (path.length - 1) };
    });
    const run = el.animate(keyframes, { duration: 9000, easing: "cubic-bezier(.45,0,.3,1)", fill: "forwards" });
    run.onfinish = end;
    return () => { run.cancel(); window.removeEventListener("keydown", onKey); };
  }, []);

  return (
    <div className="dance-party" aria-hidden="true">
      <div className="dance-lights" />
      {NOTES.map((n, i) => <span key={i} className="dance-note" style={{ left: `${8 + i * 16}%`, animationDelay: `${i * 0.6}s` }}>{n}</span>)}
      <div className="dance-mover" ref={mover}>
        <div className="dance-hop"><Crab width={Math.min(224, Math.round(innerWidth * 0.36))} /></div>
      </div>
    </div>
  );
}
