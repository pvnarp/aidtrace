import { AppHeader } from "../../app-header";
export default async function PayPalLabReturn({ searchParams }: { searchParams: Promise<{ cancelled?: string }> }) {
  const cancelled = (await searchParams).cancelled === "1";
  return <main className="lab-page"><AppHeader />
    <p className="eyebrow">AidTrace / Sandbox lab</p>
    <h1>{cancelled ? "Checkout cancelled." : "You have returned from PayPal."}</h1>
    <p>{cancelled ? "Return to the lab terminal. This page has requested no payment." : "Return to the lab terminal and check the order status. This page has not captured a payment or verified approval."}</p>
    <footer>Sandbox feasibility only. No application ledger entry is created here.</footer>
  </main>;
}
