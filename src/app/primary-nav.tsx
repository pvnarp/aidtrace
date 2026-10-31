"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActiveLink, type NavLink } from "./nav";

/** The primary links. The only client piece of the header: it reads the path to mark the current page with aria-current. */
export function PrimaryNav({ links }: { links: readonly NavLink[] }) {
  const pathname = usePathname();
  return <nav aria-label="Primary" className="tnav">{links.map(link => <Link key={link.href + link.label} href={link.href} prefetch={false} aria-current={isActiveLink(link.href, pathname) ? "page" : undefined}>{link.label}</Link>)}</nav>;
}
