import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Building2, Plus, Search } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { fetchAllApiPages, fetchApi } from "@/lib/api";

type Organization = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    "default-iac-binary"?: string;
  }>;
}>;

type MetadataDocument = Readonly<{ version?: unknown }>;

const RESERVED_ORGANIZATION_NAMES = new Set(["account", "admin"]);

export function Dashboard(): React.JSX.Element {
  const navigate = useNavigate();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [iacBinary, setIacBinary] = useState("tofu");
  const [saving, setSaving] = useState(false);

  const loadOrganizations = useCallback(async (signal?: Readonly<AbortSignal>): Promise<void> => {
    setLoading(true);
    setLoadError("");
    try {
      const data = await fetchAllApiPages<Organization>("/organizations?page[size]=100", signal);
      if (signal?.aborted !== true) setOrganizations(data);
    } catch (error: unknown) {
      if (signal?.aborted !== true) {
        setLoadError(error instanceof Error ? error.message : "Could not load organizations");
      }
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, []);

  useEffect((): (() => void) => {
    const controller = new AbortController();
    void loadOrganizations(controller.signal);
    return (): void => {
      controller.abort();
    };
  }, [loadOrganizations]);

  const visibleOrganizations = useMemo((): Organization[] => {
    const needle = search.trim().toLowerCase();
    return needle === ""
      ? organizations
      : organizations.filter((organization): boolean =>
        organization.attributes.name.toLowerCase().includes(needle));
  }, [organizations, search]);

  const openOrganization = (organizationName: string): void => {
    void navigate(`/app/${encodeURIComponent(organizationName)}`);
  };

  const createOrganization = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const organizationName = name.trim();
    if (organizationName === "" || RESERVED_ORGANIZATION_NAMES.has(organizationName.toLowerCase())) return;
    setSaving(true);
    try {
      const response = await fetchApi("/api/v2/organizations", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "organizations",
            attributes: {
              name: organizationName,
              "default-iac-binary": iacBinary,
            },
          },
        }),
      }) as { data?: Organization };
      const createdName = response.data?.attributes.name ?? organizationName;
      setCreateOpen(false);
      setName("");
      toast.add({ title: "Organization created", type: "success" });
      openOrganization(createdName);
    } catch (error: unknown) {
      toast.add({
        title: "Could not create organization",
        description: error instanceof Error ? error.message : "Unknown error",
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  const reservedName = RESERVED_ORGANIZATION_NAMES.has(name.trim().toLowerCase());

  const [appVersion, setAppVersion] = useState("");
  useEffect((): (() => void) | undefined => {
    const controller = new AbortController();
    fetchApi("/api/v1/metadata", { signal: controller.signal })
      .then((response): void => {
        const version = (response as MetadataDocument).version;
        if (typeof version === "string") {
          const safe = version.replace(/[^A-Za-z0-9._-]/g, "");
          if (safe !== "") setAppVersion(safe);
        }
      })
      .catch((): void => { /* ignore */ });
    return (): void => { controller.abort(); };
  }, []);

  return (
    <div className="flex w-full flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Infrastructure administration</p>
          <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Group projects, workspaces, teams, and shared configuration.
          </p>
        </div>
        <Button onClick={(): void => { setCreateOpen(true); }}>
          <Plus data-icon="inline-start" />
          New organization
        </Button>
      </header>

      <div className="relative max-w-md">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search organizations"
          className="pl-9"
          placeholder="Search organizations"
          value={search}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setSearch(event.target.value); }}
        />
      </div>

      {loadError !== "" && organizations.length > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>Organizations could not be refreshed. Showing the last loaded results.</span>
          <Button size="sm" variant="outline" onClick={(): void => { void loadOrganizations(); }}>Try again</Button>
        </div>
      )}

      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Organization</TableHead>
              <TableHead>Default engine</TableHead>
              <TableHead className="w-28 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={3} className="h-28 text-center">
                  <Spinner aria-label="Loading organizations" />
                </TableCell>
              </TableRow>
            ) : loadError !== "" && organizations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-28 text-center">
                  <p role="alert" className="font-medium text-destructive">Could not load organizations</p>
                  <p className="mt-1 text-sm text-muted-foreground">{loadError}</p>
                  <Button className="mt-3" size="sm" variant="outline" onClick={(): void => { void loadOrganizations(); }}>
                    Try again
                  </Button>
                </TableCell>
              </TableRow>
            ) : visibleOrganizations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-28 text-center text-muted-foreground">
                  <Building2 aria-hidden="true" className="mx-auto mb-2 size-5" />
                  <p className="font-medium text-foreground">
                    {organizations.length === 0 ? "No organizations yet" : "No organizations found"}
                  </p>
                  <p className="mt-1 text-sm">
                    {organizations.length === 0 ? "Create one to get started." : "Try a different search."}
                  </p>
                </TableCell>
              </TableRow>
            ) : visibleOrganizations.map((organization): React.JSX.Element => (
              <TableRow key={organization.id}>
                <TableCell>
                  <Link
                    to={`/app/${encodeURIComponent(organization.attributes.name)}`}
                    className="font-semibold text-primary hover:underline"
                  >
                    {organization.attributes.name}
                  </Link>
                </TableCell>
                <TableCell className="capitalize text-muted-foreground">
                  {organization.attributes["default-iac-binary"] ?? "tofu"}
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    to={`/app/${encodeURIComponent(organization.attributes.name)}`}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    Open
                    <ArrowRight data-icon="inline-end" />
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="mt-auto text-xs text-muted-foreground">Terrence{appVersion === "" ? "" : ` v${appVersion}`}</p>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an organization</DialogTitle>
            <DialogDescription>
              Organizations contain your projects, workspaces, and teams.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createOrganization}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="organization-name">Name</FieldLabel>
                <Input
                  id="organization-name"
                  autoFocus
                  autoComplete="off"
                  placeholder="acme"
                  value={name}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                />
                {reservedName && (
                  <p role="alert" className="text-sm text-destructive">This organization name is reserved.</p>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="organization-engine">Default engine</FieldLabel>
                <Select id="organization-engine" value={iacBinary} onValueChange={setIacBinary}>
                  <option value="tofu">OpenTofu</option>
                  <option value="terraform">Terraform</option>
                </Select>
              </Field>
            </FieldGroup>
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" onClick={(): void => { setCreateOpen(false); }}>
                Cancel
              </Button>
              <Button type="submit" disabled={name.trim() === "" || reservedName || saving}>
                {saving && <Spinner data-icon="inline-start" />}
                Create organization
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
