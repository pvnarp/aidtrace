import Link from "next/link";
import { paypalParts } from "./shell-copy";

/**
 * The one place the display brand lives: product name, mark and header tag.
 * The owner may rename the product. Edit BRAND here and every header, page title and
 * sign-in line follows. Names inside explanatory sentences are plain copy, not brand chrome.
 * `organization` is the fixture organization's display name, shown in the header only.
 * `tag` is the default header tag. The header passes the configuration-aware tag (shellWording).
 */
export const BRAND = { name: "AidTrace", mark: "a", tag: "AI + PayPal", organization: "Lanternfield Community Alliance" } as const;

/** Text with the word PayPal in PayPal blue (amendment 1). Plain text otherwise. */
export function PayPalText({ text }: { text: string }) {
  return <>{paypalParts(text).map((part, index) => part.paypal ? <span key={index} className="paypal-word">{part.text}</span> : part.text)}</>;
}

export function Brand({ tag = BRAND.tag }: { tag?: string }) {
  return <Link className="brand" href="/"><b className="brand-mark" aria-hidden="true">{BRAND.mark}</b><strong>{BRAND.name}</strong><span className="header-tag"><PayPalText text={tag} /></span></Link>;
}
