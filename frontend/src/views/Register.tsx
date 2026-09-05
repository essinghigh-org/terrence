import { AuthLayout } from "../components/brand/AuthLayout";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi, setAuthToken } from "@/lib/api";
import { resolveReturnTarget } from "@/lib/return-to";


export function Register(): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkingSignup, setCheckingSignup] = useState(true);
  const [signupDisabled, setSignupDisabled] = useState(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // A deep link that bounced through login may carry ?returnTo= here; restore
  // it through the same validator Login uses (issue #642).
  const returnTo = searchParams.get("returnTo");
  const loginTarget = returnTo === null ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;

  useEffect((): void => {
    fetchApi<{ "signup-enabled"?: boolean }>("/ping")
      .then((data): void => {
        const resp = data;
        if (resp["signup-enabled"] === false) {
          setSignupDisabled(true);
          void navigate(loginTarget);
        }
      })
      .catch((): void => { /* assume signup is enabled */ })
      .finally((): void => { setCheckingSignup(false); });
  }, [navigate, loginTarget]);

  const handleRegister = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setError("");

    if (email.trim() === "") {
      setError("Email address is required.");
      return;
    }

    setSubmitting(true);

    try {
      try {
        await fetchApi("/users", {
          method: "POST",
          body: JSON.stringify({
            data: { type: "users", attributes: { username, email: email.trim(), password } },
          }),
        });
      } catch (signupError: unknown) {
        const message = signupError instanceof Error ? signupError.message : "Failed to create account";
        setError(message);
        return;
      }

      try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
        const login = await fetchApi("/users/login", {
          method: "POST",
          body: JSON.stringify({ data: { attributes: { username, password, "browser-session": true } } }),
        }) as { data: { attributes: { token: string; "expired-at"?: string | null } } };
        setAuthToken(login.data.attributes.token, login.data.attributes["expired-at"], true);
        await navigate(resolveReturnTarget(returnTo));
      } catch (_loginError: unknown) {
        setError("Account created, but failed to log in automatically. Please sign in.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (checkingSignup) {
    return (
      <AuthLayout mode="signup">
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="size-5" />Checking account registration…</div>
      </AuthLayout>
    );
  }

  if (signupDisabled) {
    return (
      <AuthLayout mode="signup">
        <Card className="login-card w-full max-w-sm">
          <CardHeader>
            <CardTitle>Signup disabled</CardTitle>
            <CardDescription>Local account creation is disabled on this instance.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link to="/login" className={buttonVariants({ variant: "outline", className: "w-full" })}>Sign in</Link>
          </CardFooter>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout mode="signup">
      <Card className="login-card w-full max-w-sm">
        <CardHeader>
          <p className="mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase">Welcome aboard</p>
          <h1 className="font-heading text-3xl font-bold tracking-tight">Create your account</h1>
          <CardDescription>Join this Terrence instance to manage your infrastructure with your team.</CardDescription>
        </CardHeader>
        <form onSubmit={handleRegister}>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="register-username">Username</FieldLabel>
                <Input
                  id="register-username"
                  name="username"
                  value={username}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setUsername(event.currentTarget.value); }}
                  autoComplete="username"
                  aria-invalid={Boolean(error)}
                  required
                  autoFocus
                />
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="register-email">Email address</FieldLabel>
                <Input
                  id="register-email"
                  name="email"
                  type="email"
                  value={email}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setEmail(event.currentTarget.value); }}
                  autoComplete="email"
                  aria-invalid={Boolean(error)}
                  required
                />
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="register-password">Password</FieldLabel>
                <Input
                  id="register-password"
                  name="password"
                  type="password"
                  value={password}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setPassword(event.currentTarget.value); }}
                  autoComplete="new-password"
                  minLength={10}
                  aria-describedby="register-password-hint"
                  aria-invalid={Boolean(error)}
                  required
                />
              </Field>
              <p id="register-password-hint" className="text-xs text-muted-foreground">Use at least 10 characters for your password.</p>
              <FieldError>{error}</FieldError>
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting && <Spinner data-icon="inline-start" />}
              {submitting ? "Creating account…" : "Create account"}
            </Button>
            <Link to="/login" className={buttonVariants({ variant: "link" })}>
              Sign in instead
            </Link>
          </CardFooter>
        </form>
      </Card>
    </AuthLayout>
  );
}