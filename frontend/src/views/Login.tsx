import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi, setAuthToken } from "@/lib/api";

export function Login(): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [mfaChallengeToken, setMfaChallengeToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const navigate = useNavigate();

  useEffect((): void => {
    fetchApi("/ping")
      .then((data: unknown): void => {
        const resp = data as { "signup-enabled"?: boolean };
        setSignupEnabled(resp["signup-enabled"] !== false);
      })
      .catch((): void => { setSignupEnabled(true); });
  }, []);

  const handleLogin = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetchApi("/users/login", {
        method: "POST",
        body: JSON.stringify({ data: { attributes: { username, password, "browser-session": true } } }),
      }) as { data: { attributes: { token?: string; "expired-at"?: string | null; "must-change-password"?: boolean; "mfa-required"?: boolean; "mfa-challenge-token"?: string } } };
      const attributes = response.data.attributes;
      if (attributes["mfa-required"] === true && typeof attributes["mfa-challenge-token"] === "string") {
        setMfaChallengeToken(attributes["mfa-challenge-token"]);
        setMfaCode("");
        return;
      }
      if (typeof attributes.token !== "string") throw new Error("Missing access token");
      setAuthToken(attributes.token, attributes["expired-at"], true);
      await navigate(attributes["must-change-password"] === true ? "/app/account" : "/app");
    } catch (_error: unknown) {
      setError("Check your username and password, then try again.");
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
      const response = await fetchApi("/users/login/mfa", {
        method: "POST",
        body: JSON.stringify({ data: { attributes: { "challenge-token": mfaChallengeToken, code: mfaCode.trim(), "browser-session": true } } }),
      }) as { data: { attributes: { token: string; "expired-at"?: string | null; "must-change-password"?: boolean } } };
      const attributes = response.data.attributes;
      setAuthToken(attributes.token, attributes["expired-at"], true);
      await navigate(attributes["must-change-password"] === true ? "/app/account" : "/app");
    } catch (_error: unknown) {
      setError("That authentication code was not accepted. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader>
          <div aria-hidden="true" className="mb-2 flex size-10 items-center justify-center rounded-md bg-foreground text-lg font-bold text-background">
            T
          </div>
          <CardTitle>{mfaChallengeToken === null ? "Sign in to Terrence" : "Verify your sign-in"}</CardTitle>
          <CardDescription>{mfaChallengeToken === null ? "Continue to your organizations and workspaces." : "Enter the 6-digit code from your authenticator app."}</CardDescription>
        </CardHeader>
        <form onSubmit={mfaChallengeToken === null ? handleLogin : handleMfaChallenge}>
          <CardContent>
            <FieldGroup>
              {mfaChallengeToken === null ? (
                <>
                  <Field data-invalid={error !== ""}>
                    <FieldLabel htmlFor="login-username">Username or email address</FieldLabel>
                    <Input id="login-username" value={username} autoComplete="username" autoFocus required aria-invalid={error !== ""} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setUsername(event.currentTarget.value); }} />
                  </Field>
                  <Field data-invalid={error !== ""}>
                    <FieldLabel htmlFor="login-password">Password</FieldLabel>
                    <Input id="login-password" type="password" value={password} autoComplete="current-password" required aria-invalid={error !== ""} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setPassword(event.currentTarget.value); }} />
                  </Field>
                </>
              ) : (
                <Field data-invalid={error !== ""}>
                  <FieldLabel htmlFor="login-mfa-code">Authentication code</FieldLabel>
                  <Input id="login-mfa-code" inputMode="numeric" autoComplete="one-time-code" autoFocus required aria-invalid={error !== ""} value={mfaCode} onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setMfaCode(event.currentTarget.value); }} placeholder="6-digit code" />
                </Field>
              )}
              <FieldError>{error}</FieldError>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button type="submit" className="w-full" disabled={submitting || (mfaChallengeToken === null ? username === "" || password === "" : mfaCode.trim() === "")}>
              {submitting && <Spinner data-icon="inline-start" />}
              {mfaChallengeToken === null ? "Sign in" : "Verify code"}
            </Button>
            {mfaChallengeToken !== null && (
              <Button type="button" variant="link" onClick={(): void => { setMfaChallengeToken(null); setMfaCode(""); setError(""); }}>
                Use a different account
              </Button>
            )}
            {mfaChallengeToken === null && signupEnabled && (
              <Link to="/register" className={buttonVariants({ variant: "link" })}>
                Create account
              </Link>
            )}
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
