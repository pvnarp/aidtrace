import Link from "next/link";
import { paypalParts } from "./shell-copy";

/**
 * The one place the display brand lives: product name, mark and header tag.
 * The owner may rename the product. Edit BRAND here and every header, page title and
 * sign-in line follows. Names inside explanatory sentences are plain copy, not brand chrome.
 * `organization` is the fixture organization's display name, shown in the header only.
 * `tag` is the default header tag. The header passes the configuration-aware tag (shellWording).
 */
export const BRAND = { name: "AidTrace", tag: "AI + PayPal", organization: "Lanternfield Community Alliance" } as const;

/** Text with the word PayPal in PayPal blue (amendment 1). Plain text otherwise. */
export function PayPalText({ text }: { text: string }) {
  return <>{paypalParts(text).map((part, index) => part.paypal ? <span key={index} className="paypal-word">{part.text}</span> : part.text)}</>;
}

/** The trace mark: a navy dot, a line and an accent dot. Decorative, so it is hidden from assistive technology. Colors come from the tokens in style.css. */
export function TraceMark() {
  return <svg className="mark" width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" focusable="false">
    <path className="mark-line" d="M7.2 6h13.6" /><circle className="mark-start" cx="4" cy="6" r="3" /><circle className="mark-end" cx="24" cy="6" r="3" /></svg>;
}

export function Brand({ tag = BRAND.tag }: { tag?: string }) {
  return <Link className="brand" href="/"><TraceMark /><strong className="brand-name">{BRAND.name}</strong><span className="header-tag"><PayPalText text={tag} /></span></Link>;
}
