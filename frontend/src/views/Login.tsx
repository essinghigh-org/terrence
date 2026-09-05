import { Terrence, TerrenceLogo } from "@/components/brand/Terrence";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { ApiError, fetchApi, setAuthToken } from "@/lib/api";
import { isString } from "../lib/type-guards";


export function Login(): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [localAuthEnabled, setLocalAuthEnabled] = useState(true);
  const [samlEnabled, setSamlEnabled] = useState(false);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [ldapEnabled, setLdapEnabled] = useState(false);
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // When this login was triggered by `terraform login`, the backend stashed
  // the OAuth/PKCE handshake under an opaque state id and redirected here with
  // `?oauth_state=...`. Instead of entering the SPA, complete the handshake by
  // returning to the backend, which issues the authorization code to Terraform.
  const oauthState = searchParams.get("oauth_state");

  // Destination to restore after sign-in (set by ProtectedRoute when it
  // bounces an unauthenticated deep link to /login). Only same-origin /app
  // paths are honored so the flag can never act as an open redirect.
  const returnTo = searchParams.get("returnTo");
  const returnTarget = (): string => {
    if (returnTo === null || !returnTo.startsWith("/app/") && returnTo !== "/app") return "/app";
    if (returnTo.startsWith("//")) return "/app";
    if (/[\r\n]/.test(returnTo) || returnTo.includes("/../")) return "/app";
    return returnTo;
  };

  const finishOauthHandshake = (): void => {
    if (oauthState === null || oauthState === "") return;
    window.location.href = `/oauth/authorization/complete?oauth_state=${encodeURIComponent(oauthState)}`;
  };

  // Arriving from the email-verification redirect (backend 302s the click-through
  // here when no browser session exists). Confirm the outcome, then keep the
  // post-login destination pointing at Account so "Verified" is visible.
  useEffect((): void => {
    if (searchParams.get("email-verified") === "1") {
      // Neutral wording: this browser cannot prove which account the token
      // verified, so don't assert the signed-in state here.
      toast.add({ title: "Verification link processed", description: "Sign in to see your verification status.", type: "success" });
      return;
    }
    const failed = searchParams.get("email-verification");
    if (failed !== null) {
      const reasons: Record<string, string> = {
        missing: "This verification link was incomplete.",
        expired: "This verification link has expired or was already used. Send a new one from your account settings.",
        changed: "Your email address changed since this link was sent. Request a new verification email.",
        suspended: "Suspended accounts cannot verify their email address.",
      };
      toast.add({ title: "Email verification failed", description: reasons[failed] ?? "The verification link was not accepted.", type: "warning" });
    }
  }, [searchParams]);

  useEffect((): void => {
    fetchApi<{ "signup-enabled"?: boolean; "local-auth-enabled"?: boolean; sso?: { saml?: boolean; oidc?: boolean; ldap?: boolean } }>("/ping")
      .then((data): void => {
        const resp = data;
        setSignupEnabled(resp["signup-enabled"] !== false);
        setLocalAuthEnabled(resp["local-auth-enabled"] !== false);
        setSamlEnabled(resp.sso?.saml === true);
        setOidcEnabled(resp.sso?.oidc === true);
        setLdapEnabled(resp.sso?.ldap === true);
      })
      .catch((): void => { setSignupEnabled(true); setLocalAuthEnabled(true); });
  }, []);

  const ssoEnabled = samlEnabled || oidcEnabled;
  const showLocalForm = localAuthEnabled || ldapEnabled;

  const completeSignIn = async (attributes: { token?: string; "expired-at"?: string | null; "must-change-password"?: boolean }): Promise<void> => {
    if (!isString(attributes.token)) throw new Error("Missing access token");
    setAuthToken(attributes.token, attributes["expired-at"], true);
    if (oauthState !== null && oauthState !== "") {
      finishOauthHandshake();
      return;
    }
    // A pending password change always wins over the stored destination;
    // otherwise restore where the user was heading when sign-in interrupted.
    await navigate(attributes["must-change-password"] === true ? "/app/account" : returnTarget());
  };

  const handleLogin = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/users/login", {
        method: "POST",
        body: JSON.stringify({ data: { attributes: { username, password, "browser-session": true } } }),
      }) as { data: { attributes: { token?: string; "expired-at"?: string | null; "must-change-password"?: boolean; "mfa-required"?: boolean; "mfa-challenge-token"?: string } } };
      const attributes = response.data.attributes;
      if (attributes["mfa-required"] === true && isString(attributes["mfa-challenge-token"])) {
        setMfaChallengeToken(attributes["mfa-challenge-token"]);
        setMfaCode("");
        return;
      }
      await completeSignIn(attributes);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        // Surface the backend\'s specific message (e.g. invitation not accepted,
        // LDAP unavailable, rate-limited) instead of always blaming the password.
        // For generic 401 invalid-credentials, the backend already returns that
        // exact detail, so we can show it directly.
        setError(error.message);
      } else if (error instanceof Error) {
        setError(error.message);
      } else {
        setError("Check your username and password, then try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaChallenge = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (mfaChallengeToken === null || mfaCode.trim() === "") return;
    setError("");
    setSubmitting(true);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi("/users/login/mfa", {
        method: "POST",
        body: JSON.stringify({ data: { attributes: { "challenge-token": mfaChallengeToken, code: mfaCode.trim(), "browser-session": true } } }),
      }) as { data: { attributes: { token: string; "expired-at"?: string | null; "must-change-password"?: boolean } } };
      const attributes = response.data.attributes;
      await completeSignIn(attributes);
    } catch (error: unknown) {
      if (error instanceof ApiError) setError(error.message);
      else if (error instanceof Error) setError(error.message);
      else setError("That authentication code was not accepted. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <section className="login-story" aria-label="Welcome to Terrence">
        <Link to="/" className="login-brand" aria-label="Terrence home"><TerrenceLogo wordmark /></Link>
        <div className="login-story-content">
          <p className="login-eyebrow">A little order for your infrastructure</p>
          <h2>Big plans.<br />Steady hands.</h2>
          <p className="login-story-description">Your workspaces, plans, and people.<br />Together in one place.</p>
          <div className="login-illustration">
            <div className="login-orbit" aria-hidden="true" />
            <span className="login-node login-node--plan" aria-hidden="true">plan</span>
            <span className="login-node login-node--apply" aria-hidden="true">apply</span>
            <Terrence animated className="login-mascot" />
            <span className="login-illustration-caption">Meet Terrence. Your infrastructure companion.</span>
          </div>
        </div>
        <p className="login-story-footer">Made for OpenTofu &amp; Terraform.</p>
      </section>
      <section className="login-form-panel" aria-label="Sign in">
      <TerrenceLogo wordmark className="login-mobile-brand" />
      <Card className="login-card w-full max-w-sm">

        <CardHeader>
          <p className="mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase">{mfaChallengeToken === null ? "Welcome back" : "One more step"}</p>
          <h1 className="font-heading text-3xl font-bold tracking-tight">{mfaChallengeToken === null ? "Sign in to Terrence" : "Verify your sign-in"}</h1>
          <CardDescription>{mfaChallengeToken === null ? "Continue to your organizations and workspaces." : "Enter the 6-digit code from your authenticator app."}</CardDescription>
        </CardHeader>
        <form onSubmit={mfaChallengeToken === null ? handleLogin : handleMfaChallenge}>
          <CardContent>
            <FieldGroup>
              {mfaChallengeToken === null ? (
                <>
                  {!localAuthEnabled && !ldapEnabled && (
                    <div role="status" className="mb-3 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                      {!samlEnabled && !oidcEnabled
                        ? "No authentication methods are configured. Contact an administrator."
                        : "Local password sign-in is disabled. Use single sign-on below."}
                    </div>
                  )}
                  {showLocalForm && (
                    <>
                      <Field data-invalid={error !== ""}>
                        <FieldLabel htmlFor="login-username">Username or email address</FieldLabel>
                      <Input id="login-username" name="username" value={username} autoComplete="username" autoFocus required aria-invalid={error !== ""} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setUsername(event.currentTarget.value); }} />
                      </Field>
                      <Field data-invalid={error !== ""}>
                        <FieldLabel htmlFor="login-password">Password</FieldLabel>
                      <Input id="login-password" name="password" type="password" value={password} autoComplete="current-password" required aria-invalid={error !== ""} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setPassword(event.currentTarget.value); }} />
                      </Field>
                    </>
                  )}
                </>
              ) : (
                <Field data-invalid={error !== ""}>
                  <FieldLabel htmlFor="login-mfa-code">Authentication code</FieldLabel>
                  <Input id="login-mfa-code" name="mfa-code" inputMode="numeric" autoComplete="one-time-code" autoFocus required aria-invalid={error !== ""} value={mfaCode} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setMfaCode(event.currentTarget.value); }} placeholder="6-digit code" />
                </Field>
              )}
              <FieldError>{error}</FieldError>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            {mfaChallengeToken === null && ssoEnabled && (
              <div className="flex w-full flex-col gap-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">
                  {showLocalForm ? "Or sign in with single sign-on" : "Sign in with single sign-on"}
                </p>
                {samlEnabled && (
                  <Button type="button" variant="outline" className="w-full" onClick={(): void => { window.location.href = "/users/saml/auth"; }}>
                    Sign in with SAML SSO
                  </Button>
                )}
                {oidcEnabled && (
                  <Button type="button" variant="outline" className="w-full" onClick={(): void => { window.location.href = "/users/oidc/auth"; }}>
                    Sign in with OpenID Connect
                  </Button>
                )}
              </div>
            )}
            {(showLocalForm || mfaChallengeToken !== null) && (
              <Button type="submit" className="w-full" disabled={submitting || (mfaChallengeToken === null ? username === "" || password === "" : mfaCode.trim() === "")}>
                {submitting && <Spinner data-icon="inline-start" />}
                {mfaChallengeToken === null ? "Sign in" : "Verify code"}
              </Button>
            )}
            {mfaChallengeToken !== null && (
              <Button type="button" variant="link" onClick={(): void => { setMfaChallengeToken(null); setMfaCode(""); setError(""); }}>
                Use a different account
              </Button>
            )}
            {mfaChallengeToken === null && localAuthEnabled && signupEnabled && (
              <Link to="/register" className={buttonVariants({ variant: "link" })}>
                Create account
              </Link>
            )}
          </CardFooter>
        </form>
      </Card>
      <p className="login-form-note">Infrastructure automation, with a human touch.</p>
      </section>
    </main>
  );
}