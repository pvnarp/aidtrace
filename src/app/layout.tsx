import type { Metadata } from "next";
import localFont from "next/font/local";
import "./style.css";
import { BRAND } from "./brand";
import { AppFooter } from "./app-footer";

const inter = localFont({
  src: "./fonts/InterVariable.woff2",
  variable: "--font-aidtrace",
  weight: "100 900",
  style: "normal",
  display: "swap",
  fallback: ["Arial", "sans-serif"],
});

export const metadata: Metadata = { title: BRAND.name, description: "Restricted-fund allocation for small nonprofits." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className={inter.variable}><body>{children}<AppFooter /></body></html>;
}
