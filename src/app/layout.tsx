import type { Metadata } from "next";
import localFont from "next/font/local";
import "./style.css";

const inter = localFont({
  src: "./fonts/InterVariable.woff2",
  variable: "--font-aidtrace",
  weight: "100 900",
  style: "normal",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = { title: "AidTrace", description: "Restricted-fund allocation for small nonprofits." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={inter.variable}><body>{children}</body></html>;
}
