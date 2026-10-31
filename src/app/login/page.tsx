import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { findSession, SESSION_COOKIE } from "../../server/auth";
import { BRAND } from "../brand";
import { AppHeader } from "../app-header";

// IAC-403: the locked mock's Sign-in screen. The form, its field names, autocomplete, limits, error alert and POST target are unchanged.
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && await findSession(token)) redirect("/");
  const error = (await searchParams).error;
  return <><AppHeader /><main className="login-page reference-page">
    <div className="reference-screen">
      <p className="kicker">{BRAND.name} / {BRAND.tag} for nonprofits</p>
      <h1 className="screen-heading">Review an expense. Honor each fund.</h1>
      <p className="reference-intro">AI helps prepare. Rules calculate funding. Two different people approve. PayPal remains a separate decision.</p>
      <div className="reference-two">
        <article className="reference-card" aria-labelledby="signin-title"><h2 id="signin-title">Sign in to your own account</h2>
          {error && <p role="alert">Sign-in failed. Check your credentials, or wait 15 minutes if you have made repeated attempts.</p>}
          <form action="/api/auth/login" method="post" className="login-form">
            <label htmlFor="username">Username</label>
            <input id="username" name="username" autoComplete="username" required maxLength={32} autoCapitalize="none" spellCheck={false} />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={72} />
            <button type="submit">Sign in</button>
          </form>
          <p className="reference-caption">Each account has its own generated password, supplied with your setup. Sign in separately for each role.</p>
        </article>
        <article className="reference-note" aria-labelledby="people-title"><h2 id="people-title">Three people, distinct responsibilities</h2>
          <p><strong>Maria</strong> (username maria) enters the receipt, checks AI suggestions and freezes the split.</p>
          <p><strong>Tara and Ben</strong> (usernames tara and ben) independently review the same frozen terms.</p>
          <p>Signing in as one person never grants another person's identity or records an approval.</p>
        </article>
      </div>
    </div>
    <footer>Sandbox demo with fictional data. Sign in separately for each role.</footer>
  </main></>;
}
