import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { findSession, SESSION_COOKIE } from "../../server/auth";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && await findSession(token)) redirect("/");
  const error = (await searchParams).error;
  return <main className="login-page">
    <p className="eyebrow">AidTrace / AI + PayPal for nonprofits</p>
    <h1>Sign in to AidTrace.</h1>
    <p className="intro">One expense. Different donor restrictions. AI helps prepare it, rules find the funding, people approve and PayPal reimburses.</p>
    <p>Use your generated demo account: maria, tara, or ben. Each has a separate password in the private configuration supplied with your setup.</p>
    {error && <p role="alert">Sign-in failed. Check your credentials, or wait 15 minutes if you have made repeated attempts.</p>}
    <form action="/api/auth/login" method="post" className="login-form">
      <label htmlFor="username">Username</label>
      <input id="username" name="username" autoComplete="username" required maxLength={32} autoCapitalize="none" spellCheck={false} />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={72} />
      <button type="submit">Sign in</button>
    </form>
    <footer>Local sandbox demo. Sign in separately for each role.</footer>
  </main>;
}
