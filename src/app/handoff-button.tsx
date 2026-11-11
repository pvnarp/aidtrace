"use client";
import { useState } from "react";
import { handoffTarget } from "./thread";

/**
 * "Sign out and continue as Tara": posts to the existing /api/auth/logout (same origin, no body), then opens sign-in with the username
 * filled. It changes no authentication rule: the session really ends first, and the next person still types their own password.
 * If the sign-out fails the page stays where it is and says so.
 */
export function HandoffButton({ username, label }: { username: string | null; label: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  async function go() {
    setBusy(true); setFailed(false);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      if (!response.ok) throw new Error("sign-out refused");
      window.location.assign(handoffTarget(username));
    } catch { setBusy(false); setFailed(true); }
  }
  return <div className="journey-handoff">
    <button type="button" className="secondary" onClick={go} disabled={busy} aria-busy={busy ? "true" : undefined}>{label}</button>
    {failed && <p role="alert" className="muted">Sign-out did not complete. Use Sign out in the header, then sign in again.</p>}
  </div>;
}
