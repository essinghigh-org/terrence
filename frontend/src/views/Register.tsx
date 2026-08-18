import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi, setAuthToken } from "@/lib/api";


export function Register(): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checkingSignup, setCheckingSignup] = useState(true);
  const [signupDisabled, setSignupDisabled] = useState(false);
  const navigate = useNavigate();

  useEffect((): void => {
    fetchApi<{ "signup-enabled"?: boolean }>("/ping")
      .then((data): void => {
        const resp = data;
        if (resp["signup-enabled"] === false) {
          setSignupDisabled(true);
          void navigate("/login");
        }
      })
      .catch((): void => { /* assume signup is enabled */ })
      .finally((): void => { setCheckingSignup(false); });
  }, [navigate]);

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
        await navigate("/app");
      } catch (_loginError: unknown) {
        setError("Account created, but failed to log in automatically. Please sign in.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (checkingSignup) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <Spinner className="size-6" />
      </main>
    );
  }

  if (signupDisabled) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
        <Card className="w-full max-w-sm shadow-sm">
          <CardHeader>
            <CardTitle>Signup disabled</CardTitle>
            <CardDescription>Local account creation is disabled on this instance.</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link to="/login" className="w-full">
              <Button className="w-full" variant="outline">Sign in</Button>
            </Link>
          </CardFooter>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm shadow-sm">
        <CardHeader>
          <div aria-hidden="true" className="mb-2 flex size-10 items-center justify-center rounded-md bg-foreground text-lg font-bold text-background">
            T
          </div>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>Start a self-hosted Terrence instance with a local user.</CardDescription>
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
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setUsername(event.target.value); }}
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
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setEmail(event.target.value); }}
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
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setPassword(event.target.value); }}
                  autoComplete="new-password"
                  minLength={10}
                  aria-invalid={Boolean(error)}
                  required
                />
              </Field>
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
    </main>
  );
}