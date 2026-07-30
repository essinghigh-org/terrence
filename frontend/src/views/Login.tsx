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
        body: JSON.stringify({
          data: { attributes: { username, password, "browser-session": true } },
        }),
      }) as {
        data: {
          attributes: {
            token: string;
            "expired-at"?: string | null;
            "must-change-password"?: boolean;
          };
        };
      };
      setAuthToken(response.data.attributes.token, response.data.attributes["expired-at"], true);
      await navigate(response.data.attributes["must-change-password"] === true ? "/app/account" : "/app");
    } catch (_error: unknown) {
      setError("Check your username and password, then try again.");
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
          <CardTitle>Sign in to Terrence</CardTitle>
          <CardDescription>Continue to your organizations and workspaces.</CardDescription>
        </CardHeader>
        <form onSubmit={handleLogin}>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={error !== ""}>
                <FieldLabel htmlFor="login-username">Username or email address</FieldLabel>
                <Input
                  id="login-username"
                  value={username}
                  autoComplete="username"
                  autoFocus
                  required
                  aria-invalid={error !== ""}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setUsername(event.currentTarget.value); }}
                />
              </Field>
              <Field data-invalid={error !== ""}>
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <Input
                  id="login-password"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  required
                  aria-invalid={error !== ""}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setPassword(event.currentTarget.value); }}
                />
              </Field>
              <FieldError>{error}</FieldError>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button type="submit" className="w-full" disabled={submitting || username === "" || password === ""}>
              {submitting && <Spinner data-icon="inline-start" />}
              Sign in
            </Button>
            {signupEnabled && (
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
