"use client";
import { useEffect, useRef, useState } from "react";
export function SuggestForm({ id, reviewId, hash, suggestionHash, running }: { id: string; reviewId: string; hash: string; suggestionHash: string; running: boolean }) {
  const submitted = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    const reset = () => { submitted.current = false; setPending(false); };
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);
  async function submit(form: HTMLFormElement) {
    try {
      const body = new URLSearchParams();
      for (const [key, value] of new FormData(form)) {
        if (typeof value !== "string") throw new Error("Text form required");
        body.append(key, value);
      }
      // The hidden field named action shadows HTMLFormElement.action in browsers.
      const response = await fetch(`/api/receipts/${id}`, { method: "POST", body, credentials: "same-origin", redirect: "follow" });
      const target = new URL(response.url);
      if (response.ok && target.origin === window.location.origin && target.pathname === `/claims/${id}/receipt`) {
        window.location.assign(target.pathname + target.search); return;
      }
      setMessage(response.status === 401 ? "Your session expired. Sign in again before requesting a review." : "The result could not be confirmed. Refresh this receipt before trying again.");
    } catch { setMessage("The result could not be confirmed. Refresh this receipt before trying again."); }
    submitted.current = false; setPending(false);
  }
  return <form action={`/api/receipts/${id}`} method="post" className="action-form" aria-busy={pending || running} onSubmit={event => {
    event.preventDefault();
    if (submitted.current || running) { event.preventDefault(); return; }
    submitted.current = true; setPending(true); setMessage(""); void submit(event.currentTarget);
  }}>
    <input type="hidden" name="action" value="suggest" />
    <input type="hidden" name="reviewId" value={reviewId} />
    <input type="hidden" name="draftHash" value={hash} />
    <input type="hidden" name="suggestionHash" value={suggestionHash} />
    <button type="submit" disabled={pending || running}>{pending || running ? "AI review in progress..." : "Request AI suggestions"}</button>
    {pending && <p role="status">Checking your receipt. This may take up to a minute. You only need to submit once.</p>}
    {message && <p role="alert">{message} <a href={`/claims/${id}/receipt`}>Refresh receipt</a> or <a href="/login">sign in</a>.</p>}
  </form>;
}
