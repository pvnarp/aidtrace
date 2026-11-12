"use client";
import { useState } from "react";
import "./gift-link-panel.css";

// IAC-413 PR A: the one-time private link panel on the thank-you screen.
// The token arrives in the capture response, lives only in the React state of the parent and is never written to localStorage,
// sessionStorage, a cookie or the page URL, and is never logged. "Give again" clears it. The link is built from the page origin.
export type GiftLinkView = { state: "ISSUED"; token: string } | { state: "SHOWN_BEFORE" };
export const SHOWN_BEFORE_TEXT = "A private link for this gift was shown earlier. It cannot be shown again.";
export const COPIED_TEXT = "Link copied";
export const COPY_FAILED_TEXT = "Copy failed. Select the link and copy it by hand.";

export function GiftLinkPanel({ link }: { link: GiftLinkView }) {
  const [status, setStatus] = useState("");
  if (link.state === "SHOWN_BEFORE") return <div className="notice gift-link-panel" data-testid="gift-link-panel"><h2>Your private link</h2><p data-testid="gift-link-shown-before">{SHOWN_BEFORE_TEXT}</p></div>;
  const url = `${window.location.origin}/gift/${link.token}`;
  async function copy() {
    try { await navigator.clipboard.writeText(url); setStatus(COPIED_TEXT); } catch { setStatus(COPY_FAILED_TEXT); }
  }
  return <div className="notice gift-link-panel" data-testid="gift-link-panel">
    <h2>Your private link</h2>
    <p>Open this link any time to see where your gift went. It is shown only once and we do not keep it, so save it now. Anyone who has it can see the page. It shows no names or contact details.</p>
    <input readOnly value={url} aria-label="Your private gift link" data-testid="gift-link-field" onFocus={event => event.currentTarget.select()} />
    <div className="gift-link-actions">
      <button type="button" onClick={copy} data-testid="gift-link-copy">Copy link</button>
      <a href={url} target="_blank" rel="noopener noreferrer" data-testid="gift-link-open">Open your gift page</a>
    </div>
    <p role="status" aria-live="polite" data-testid="gift-link-status">{status}</p>
  </div>;
}
