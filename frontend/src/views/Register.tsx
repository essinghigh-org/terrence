import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi, setAuthToken } from "@/lib/api";

export function Register(): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleRegister = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      try {
        await fetchApi("/users", {
          method: "POST",
          body: JSON.stringify({
            data: { type: "users", attributes: { username, password } },
          }),
        });
      } catch (signupError: unknown) {
        const message = signupError instanceof Error ? signupError.message : "Failed to create account";
        setError(message);
        return;
      }

      try {
        const login = await fetchApi("/users/login", {
          method: "POST",
          body: JSON.stringify({ data: { attributes: { username, password } } }),
        }) as { data: { attributes: { token: string } } };
        setAuthToken(login.data.attributes.token);
        await navigate("/app");
      } catch (_loginError: unknown) {
        setError("Account created, but failed to log in automatically. Please sign in.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
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
                  value={username}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setUsername(event.target.value); }}
                  autoComplete="username"
                  aria-invalid={Boolean(error)}
                  required
                  autoFocus
                />
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="register-password">Password</FieldLabel>
                <Input
                  id="register-password"
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
              {submitting ? "Creating account" : "Create account"}
            </Button>
            <Link to="/login" className={buttonVariants({ variant: "link" })}>
              Sign in instead
            </Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
