/**
 * Display only (IAC-415 polish). A claim reference shows its first 8 characters: "R-" and six hex digits for a receipt claim, "C-104" whole.
 * The full id stays in URLs, forms, data attributes and the Reference disclosure. Nothing here shortens an id that is sent or stored.
 */
export const shortClaimRef = (id: string): string => id.slice(0, 8);
