import type { Metadata } from "next";
import { notFound } from "next/navigation";
import "./gift.css";
import { findGiftLinkCapture, isGiftTokenShape } from "../../../donation/gift-link";
import { loadGiftPage } from "../../../donation/trail";
import { getDatabase } from "../../../server/db";
import { TrailView } from "./trail-view";

// IAC-413 PR A (docs/plans/DONOR_TRAIL_SCOPE.md section 3): the public donor trail. No session, no cookies, no personal data.
// The proxy (src/proxy.ts) sets the nonce and the privacy headers and takes a limiter slot for a well-formed token before this runs.
// The page never calls cookies() or reads a session, so every visitor gets the same page. State is recomputed on every load.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your gift, step by step | AidTrace",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function GiftPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // A malformed token never reaches the database. A well-formed token with no row gets the same not-found page.
  if (!isGiftTokenShape(token)) notFound();
  const db = getDatabase();
  const captureId = await findGiftLinkCapture(db, token);
  if (!captureId) notFound();
  // A TrailInvariantError or a database fault is not caught here: it reaches error.tsx, which shows a fixed line and no data (its HTTP status is not asserted by any test).
  const data = await loadGiftPage(db, captureId);
  if (!data) notFound();
  return <TrailView data={data} />;
}
