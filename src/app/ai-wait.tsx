"use client";
import { useEffect, useState } from "react";
import { elapsedLabel } from "./ai-wait-time";

/**
 * The honest wait indicator for an AI request that this page sent and is still waiting on (receipt suggestions, expense preparation, rules drafting, the analytics answer).
 * A small dot travels a short line (motion only without a reduced-motion preference) and the real elapsed seconds count up beside it. It names no stage, because the server
 * reports none. It sends, retries and times out nothing: the caller owns the request. Mount it only while the request is pending, so it counts from the request.
 */
export function AiWait() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return <p className="ai-wait" data-testid="ai-wait"><span className="ai-wait-line" aria-hidden="true"><i /></span><span className="ai-wait-time" data-testid="ai-wait-time">{elapsedLabel(seconds)}</span></p>;
}
