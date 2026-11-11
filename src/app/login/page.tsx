import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { findSession, SESSION_COOKIE } from "../../server/auth";
import { hostedSession } from "../../server/hosted-mode";
import { BRAND } from "../brand";
import { AppHeader } from "../app-header";
import { TraceLegend } from "../trace";
import { capitalize, validAs } from "../thread";

// IAC-403: the locked mock's Sign-in screen. The form, its field names, autocomplete, limits, error alert and POST target are unchanged.
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; as?: string | string[] }> }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token && await findSession(token)) redirect("/");
  const params = await searchParams; const error = params.error;
  // The thread: a handoff opens sign-in with the next person's username filled and focus on Password. No session, no identity, no password prefill. Anything that is not a plain username is ignored.
  const asUser = validAs(params.as);
  return <><AppHeader /><main className="login-page reference-page">
    <div className="reference-screen">
      <p className="kicker">{BRAND.name} / {BRAND.tag} for nonprofits</p>
      <h1 className="screen-heading">Review an expense. Honor each fund.</h1>
      <p className="reference-intro">AI helps prepare. Rules calculate funding. Two different people approve. PayPal remains a separate decision.</p>
      <TraceLegend />
      <div className="reference-two">
        <article className="reference-card" aria-labelledby="signin-title"><h2 id="signin-title">Sign in to your own account</h2>
          {error && <p role="alert">Sign-in failed. Check your credentials, or wait 15 minutes if you have made repeated attempts.</p>}
          {asUser && <p className="reference-caption" role="status" data-testid="login-continue">Continue as {capitalize(asUser)}. Type the password for {asUser} to continue.</p>}
          <form action="/api/auth/login" method="post" className="login-form">
            <label htmlFor="username">Username</label>
            <input id="username" name="username" autoComplete="username" required maxLength={32} autoCapitalize="none" spellCheck={false} {...(asUser ? { defaultValue: asUser } : {})} />
            <label htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required maxLength={72} {...(asUser ? { autoFocus: true } : {})} />
            <button type="submit">Sign in</button>
          </form>
          <p className="reference-caption">Each account has its own generated password, supplied with your setup. Sign in separately for each role.</p>
          {hostedSession() && <p className="reference-caption" data-testid="hosted-notice">All data in this workspace is sample data with no real personal details. AI requests are limited per workspace; when the limit is reached the manual path still works.</p>}
        </article>
        <article className="reference-note" aria-labelledby="people-title"><h2 id="people-title">Three people, distinct responsibilities</h2>
          <p><strong>Maria</strong> (username maria) enters the receipt, checks AI suggestions and freezes the split.</p>
          <p><strong>Tara and Ben</strong> (usernames tara and ben) independently review the same frozen terms.</p>
          <p>Signing in as one person never grants another person's identity or records an approval.</p>
          <p className="reference-caption" data-testid="login-order">Start as maria. Then sign in as tara, then as ben, each with their own password.</p>
        </article>
      </div>
    </div>
  </main></>;
}
