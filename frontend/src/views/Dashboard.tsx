import { useEffect, useState } from "react";
import { fetchApi } from "@/lib/api";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

export function Dashboard() {
  const [orgs, setOrgs] = useState<any[]>([]);
  const [organizationName, setOrganizationName] = useState("");
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchApi("/organizations").then(data => setOrgs(data.data)).catch(console.error);
  }, []);

  const createOrganization = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const response = await fetchApi("/organizations", {
        method: "POST",
        body: JSON.stringify({
          data: { type: "organizations", attributes: { name: organizationName } },
        }),
      });
      setOrgs(current => [...current, response.data]);
      setOrganizationName("");
      setDialogOpen(false);
    } catch (caught: any) {
      setError(caught.message || "Failed to create organization");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-bold">Organizations</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button>Create organization</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create organization</DialogTitle>
              <DialogDescription>Organizations contain your workspaces, state, and runs.</DialogDescription>
            </DialogHeader>
            <form onSubmit={createOrganization}>
              <FieldGroup>
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor="organization-name">Name</FieldLabel>
                  <Input
                    id="organization-name"
                    value={organizationName}
                    onChange={(event) => setOrganizationName(event.target.value)}
                    aria-invalid={Boolean(error)}
                    required
                    autoFocus
                  />
                  <FieldError>{error}</FieldError>
                </Field>
                <DialogFooter>
                  <Button type="submit" disabled={creating}>
                    {creating && <Spinner data-icon="inline-start" />}
                    {creating ? "Creating" : "Create organization"}
                  </Button>
                </DialogFooter>
              </FieldGroup>
            </form>
          </DialogContent>
        </Dialog>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {orgs.map(org => (
          <Link key={org.id} to={`/app/${org.attributes.name}`}>
            <Card className="hover:shadow-md transition-shadow">
              <CardHeader>
                <CardTitle>{org.attributes.name}</CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
        {orgs.length === 0 && (
          <div className="text-muted-foreground">No organizations found.</div>
        )}
      </div>
    </div>
  );
}
