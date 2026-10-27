import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { findSession, SESSION_COOKIE } from "../../server/auth";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && await findSession(token)) redirect("/");
  const error = (await searchParams).error;
  return <main>
    <p className="eyebrow">AidTrace / Sandbox development</p>
    <h1>Sign in to AidTrace.</h1>
    <p>Use your seeded account: maria, tara, or ben. Each has a separate password.</p>
    {error && <p role="alert">Sign-in failed. Check your credentials, or wait 15 minutes if you have made repeated attempts.</p>}
    <form action="/api/auth/login" method="post" className="login-form">
      <label htmlFor="username">Username</label>
      <input id="username" name="username" autoComplete="username" required maxLength={32} autoCapitalize="none" spellCheck={false} />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={72} />
      <button type="submit">Sign in</button>
    </form>
    <footer>Local fixture accounts only. No signup or role switch.</footer>
  </main>;
}
