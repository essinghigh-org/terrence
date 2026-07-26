import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi, setAuthToken } from "@/lib/api";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await fetchApi("/users/login", {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              username,
              password,
            },
          },
        }),
      });
      setAuthToken(response.data.attributes.token);
      navigate("/");
    } catch (err: any) {
      setError(err.message || "Failed to login");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Login to Terrence</CardTitle>
          <CardDescription>Enter your credentials to access your workspaces.</CardDescription>
        </CardHeader>
        <form onSubmit={handleLogin}>
          <CardContent>
            <FieldGroup>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="username">Username</FieldLabel>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                aria-invalid={Boolean(error)}
                required
                autoFocus
              />
              </Field>
              <Field data-invalid={Boolean(error)}>
                <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
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
              {submitting ? "Signing in" : "Sign in"}
            </Button>
            <Link to="/register" className={buttonVariants({ variant: "link" })}>
              Create an account
            </Link>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
