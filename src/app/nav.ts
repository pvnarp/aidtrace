/**
 * Primary navigation. Real routes only (docs/plans/TRUST_V2_PORT_SCOPE.md section 3.1, decision 6).
 * To add a link, append one object to the role's list below. Nothing else changes.
 * No label may equal or contain a link name that an e2e spec queries by exact name:
 * "View funding and cash", "Explore how it works", "Give to a restricted fund", "Open this expense", "Review this expense".
 * Signed-out visitors get no links: the header shows the brand and the organization only.
 */
export type NavRole = "CLAIMANT" | "APPROVER";
export type NavLink = { readonly label: string; readonly href: string };

export const NAV_LINKS: Readonly<Record<NavRole, readonly NavLink[]>> = {
  CLAIMANT: [
    { label: "Expenses", href: "/" },
    { label: "Give", href: "/give" },
    { label: "How it works", href: "/architecture" },
  ],
  APPROVER: [
    { label: "Review", href: "/" },
    { label: "Funding and cash", href: "/analytics" },
    { label: "Ledger", href: "/ledger" },
    { label: "Donations", href: "/donations" },
    { label: "How it works", href: "/architecture" },
  ],
};

/** The links for a signed-in role. Any other role string (or none) gets no links. */
export function navLinksFor(role: string | undefined): readonly NavLink[] {
  return role === "CLAIMANT" || role === "APPROVER" ? NAV_LINKS[role] : [];
}

/** True when the link is the page the visitor is on. "/" matches only itself. Other links match their own subpaths too. */
export function isActiveLink(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}
