import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = { title: "AidTrace", description: "Restricted-fund allocation for small nonprofits." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
