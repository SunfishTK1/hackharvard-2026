// Loading and error states, shared by every view.
import type { ReactNode } from "react";
import type { Loaded } from "../core";
import { Spinner } from "../ui";

export function Load<T>({ state, children }: { state: Loaded<T>; children: (data: T) => ReactNode }) {
  if (state.data) return <>{children(state.data)}</>;
  if (state.error) {
    return (
      <div className="ws-status" role="alert">
        <p>{state.error}</p>
        <button type="button" className="btn soft" onClick={state.reload}>Try again</button>
      </div>
    );
  }
  return <div className="ws-status" role="status"><Spinner /><p>Loading…</p></div>;
}
