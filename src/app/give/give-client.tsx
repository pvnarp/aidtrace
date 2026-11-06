"use client";
import { useEffect, useRef, useState } from "react";
import { GIVE_PRESET_CENTS, formatUsd, parseUsdAmount } from "../../donation/display";
import type { GiveFund } from "../../donation/give-model";
import type { DonationView } from "../../server/donation-actions";
import { GiftLinkPanel, type GiftLinkView } from "./gift-link-panel";

// IAC-379 step 3a: PayPal Checkout buttons for a KEYED sandbox session. The server creates and captures; this component
// only shows the donor's choices and relays them. The SDK loads here and on no other page.
interface ApproveActions { restart(): Promise<void> }
interface ButtonsConfig {
  onClick(data: unknown, actions: { resolve(): Promise<void>; reject(): Promise<void> }): Promise<void>;
  createOrder(): Promise<string>;
  onApprove(data: { orderID: string }, actions: ApproveActions): Promise<void>;
  onCancel(): void;
  onError(error: unknown): void;
}
declare global { interface Window { paypal?: { Buttons(config: ButtonsConfig): { render(target: HTMLElement): Promise<void>; close?(): Promise<void> } } } }

const NETWORK = "We could not reach AidTrace. Nothing was recorded. Please try again.";
const UNCERTAIN = "We could not confirm this payment. Please do not pay again. Reload this page later to check.";
async function post(body: Record<string, string>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const response = await fetch("/api/donations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data: Record<string, unknown> = {};
  try { const parsed: unknown = await response.json(); if (parsed && typeof parsed === "object") data = parsed as Record<string, unknown>; } catch { /* the fixed fallback text applies */ }
  return { ok: response.ok, data };
}
const errorText = (data: Record<string, unknown>) => typeof data.error === "string" ? data.error : "Something went wrong. Nothing was recorded. Please try again.";
// After the donor approves in PayPal, a capture answer without a server error string (a proxy 502 page, an empty 500) must stay unknown: never "Nothing was recorded".
const captureText = (data: Record<string, unknown>) => typeof data.error === "string" ? data.error : UNCERTAIN;

export function GiveClient({ funds, clientId, nonce }: { funds: readonly GiveFund[]; clientId: string; nonce: string }) {
  const [fundId, setFundId] = useState(funds[0]?.id ?? "");
  const [choice, setChoice] = useState("2500");
  const [custom, setCustom] = useState("");
  const [name, setName] = useState("");
  const [sdk, setSdk] = useState<"loading" | "ready" | "failed">("loading");
  const [notice, setNotice] = useState("");
  const [retryRow, setRetryRow] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [giftLink, setGiftLink] = useState<GiftLinkView | null>(null); // the one-time token lives in this state only
  const container = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, string>()); // provider order ID -> stored row id
  const confirmed = useRef<{ rowId: string; orderId: string } | null>(null);
  const quiet = useRef(false); // createOrder already showed its own message, so onError stays silent once
  const cents = choice === "custom" ? parseUsdAmount(custom) : BigInt(choice);
  const latest = useRef({ fundId, cents, name });
  latest.current = { fundId, cents, name };
  const fundName = funds.find(fund => fund.id === fundId)?.name ?? "";

  useEffect(() => {
    if (window.paypal) { setSdk("ready"); return; }
    let script = document.querySelector<HTMLScriptElement>("script[data-give-sdk]");
    if (!script) {
      script = document.createElement("script");
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&components=buttons&currency=USD&intent=capture`;
      script.async = true; script.dataset.giveSdk = "true";
      if (nonce) { script.nonce = nonce; script.setAttribute("data-csp-nonce", nonce); }
      document.head.appendChild(script);
    }
    const ready = () => setSdk("ready"), failed = () => setSdk("failed");
    script.addEventListener("load", ready); script.addEventListener("error", failed);
    return () => { script.removeEventListener("load", ready); script.removeEventListener("error", failed); };
  }, [clientId, nonce]);

  useEffect(() => {
    if (sdk !== "ready" || done !== null || !window.paypal || !container.current) return;
    const buttons = window.paypal.Buttons({
      async onClick(_data, actions) {
        if (!latest.current.fundId || latest.current.cents === null) { setNotice("Choose a fund and an amount greater than zero first."); return actions.reject(); }
        return actions.resolve();
      },
      async createOrder() {
        const { fundId: fund, cents: amount, name: donor } = latest.current;
        const ready = confirmed.current;
        if (ready) { confirmed.current = null; rows.current.set(ready.orderId, ready.rowId); return ready.orderId; }
        if (!fund || amount === null) throw new Error("Choose a fund and an amount");
        setNotice("Creating your order..."); setRetryRow(null);
        let result;
        try { result = await post({ action: "create", fundId: fund, amountCents: amount.toString(), ...(donor.trim() ? { displayName: donor.trim() } : {}) }); }
        catch { quiet.current = true; setNotice(NETWORK); throw new Error("network"); }
        const view = result.data as Partial<DonationView>;
        if (result.ok && view.messageKey === "CREATED" && typeof view.orderId === "string" && typeof view.id === "string") { rows.current.set(view.orderId, view.id); setNotice("Opening PayPal..."); return view.orderId; }
        quiet.current = true;
        if (result.ok && view.messageKey === "CREATE_UNCONFIRMED") { setNotice(view.message ?? errorText(result.data)); setRetryRow(view.retry && typeof view.id === "string" ? view.id : null); }
        else setNotice(errorText(result.data));
        throw new Error("order not ready");
      },
      async onApprove(data, actions) {
        const rowId = rows.current.get(data.orderID);
        if (!rowId) { setNotice(UNCERTAIN); return; }
        setNotice("Confirming your payment with PayPal...");
        let result;
        try { result = await post({ action: "capture", id: rowId, orderId: data.orderID }); }
        catch { setNotice(UNCERTAIN); return; } // the capture may have happened: never imply it did not
        if (!result.ok) { setNotice(captureText(result.data)); return; }
        const view = result.data as Partial<DonationView>;
        setNotice(view.message ?? captureText(result.data));
        if (view.messageKey === "DECLINED" && view.restart) return actions.restart();
        if (view.messageKey === "COMPLETED") {
          setDone(view.captureTail ? `Capture ID ending in ${view.captureTail}.` : "");
          setGiftLink(view.giftLinkState === "ISSUED" && typeof view.giftToken === "string" ? { state: "ISSUED", token: view.giftToken } : view.giftLinkState === "SHOWN_BEFORE" ? { state: "SHOWN_BEFORE" } : null);
        }
      },
      onCancel() { setNotice("You closed PayPal before approving, so nothing was captured or recorded."); },
      onError() {
        if (quiet.current) { quiet.current = false; return; }
        setNotice("PayPal could not complete this step. AidTrace captured nothing. You can try again.");
      },
    });
    buttons.render(container.current).catch(() => setNotice("PayPal buttons could not be shown. Reload this page to try again."));
    return () => { buttons.close?.().catch(() => undefined); };
  }, [sdk, done]);

  const changed = () => { confirmed.current = null; setRetryRow(null); setNotice(""); };
  async function tryAgain() {
    if (!retryRow) return;
    setNotice("Checking with PayPal...");
    try {
      const result = await post({ action: "resume", id: retryRow });
      const view = result.data as Partial<DonationView>;
      if (result.ok && view.messageKey === "CREATED" && typeof view.orderId === "string" && typeof view.id === "string") {
        confirmed.current = { rowId: view.id, orderId: view.orderId }; setRetryRow(null);
        setNotice("We confirmed your order with PayPal. Choose a PayPal button to continue.");
      } else if (result.ok && view.messageKey === "CREATE_UNCONFIRMED") { setNotice(view.message ?? errorText(result.data)); setRetryRow(view.retry ? retryRow : null); }
      else { setNotice(result.ok ? view.message ?? errorText(result.data) : errorText(result.data)); setRetryRow(null); }
    } catch { setNotice(NETWORK); }
  }
  function giveAgain() { rows.current.clear(); confirmed.current = null; setDone(null); setGiftLink(null); setNotice(""); setRetryRow(null); }

  return <section className="give-panel" data-testid="give-keyed">
    <form className="receipt-form give-form" onSubmit={event => event.preventDefault()}>
      <label htmlFor="give-fund">Fund
        <select id="give-fund" value={fundId} onChange={event => { setFundId(event.target.value); changed(); }}>{funds.map(fund => <option key={fund.id} value={fund.id}>{fund.name}</option>)}</select></label>
      <fieldset><legend>Amount in USD</legend>
        <div className="give-amounts">
          {GIVE_PRESET_CENTS.map(preset => <label className="confirm" key={preset.toString()}><input type="radio" name="give-amount" checked={choice === preset.toString()} onChange={() => { setChoice(preset.toString()); changed(); }} /> {formatUsd(preset)}</label>)}
          <label className="confirm"><input type="radio" name="give-amount" checked={choice === "custom"} onChange={() => { setChoice("custom"); changed(); }} /> Other amount</label>
        </div>
        {choice === "custom" && <label htmlFor="give-custom">Other amount in USD<input id="give-custom" inputMode="decimal" autoComplete="off" placeholder="0.00" maxLength={14} value={custom} onChange={event => { setCustom(event.target.value); changed(); }} aria-invalid={custom !== "" && cents === null} /></label>}
      </fieldset>
      <label htmlFor="give-name">Your first name, to address your thank-you note (optional)
        <input id="give-name" maxLength={40} autoComplete="off" aria-describedby="give-name-hint" value={name} onChange={event => { setName(event.target.value); changed(); }} /></label>
      <p id="give-name-hint" className="muted">For example, Alex. This is not a message.</p>
    </form>
    <p data-testid="give-summary">{cents !== null && fundName ? `You are giving ${formatUsd(cents)} to ${fundName}.` : "Choose a fund and an amount greater than zero."}</p>
    {done === null ? <>
      {sdk === "loading" && <p className="muted">Loading PayPal Checkout...</p>}
      {sdk === "failed" && <p role="alert">PayPal Checkout could not load. Nothing was created. Reload this page to try again.</p>}
      <div className="give-buttons" ref={container} data-testid="give-buttons" />
    </> : <><div className="notice" data-testid="give-done"><p>{done}</p><button type="button" className="secondary" onClick={giveAgain}>Give again</button></div>{giftLink ? <GiftLinkPanel link={giftLink} /> : null}</>}
    <p role="status" aria-live="polite" data-testid="give-status">{notice}</p>
    {retryRow && <button type="button" onClick={tryAgain}>Try again</button>}
  </section>;
}
