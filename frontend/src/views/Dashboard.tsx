import { Terrence } from "../components/brand/Terrence";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Building2, Plus, Search } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";

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
import { getLastOrganization } from "@/lib/lastOrganization";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader, PageShell } from "@/components/PageHeader";
import { isString } from "../lib/type-guards";

type Organization = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    "default-iac-binary"?: string;
  }>;
}>;

type MetadataDocument = Readonly<{ version?: unknown }>;

const RESERVED_ORGANIZATION_NAMES = new Set(["account", "admin", "docs"]);

export function Dashboard(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [iacBinary, setIacBinary] = useState("terraform");
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState("");

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

  // Resume the last organization on a fresh page load (location.key ===
  // "default"), skipping redirect when the operator deliberately opened the
  // picker via the sidebar "Organizations" link or the home logo. The stored
  // org is only honored if it still exists.
  useEffect((): void => {
    if (loading || loadError !== "" || location.key !== "default") return;
    const lastOrg = getLastOrganization();
    if (lastOrg === "") {
      const onlyOrganization = organizations.length === 1 ? organizations[0] : undefined;
      if (onlyOrganization !== undefined) {
        void navigate(`/app/${encodeURIComponent(onlyOrganization.attributes.name)}`, { replace: true });
      }
      return;
    }
    if (organizations.some((organization): boolean => organization.attributes.name === lastOrg)) {
      void navigate(`/app/${encodeURIComponent(lastOrg)}`, { replace: true });
    }
  }, [loading, loadError, location.key, organizations, navigate]);

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
    if (saving) return;
    setCreateError("");
    setSaving(true);
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
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
      setCreateError(error instanceof Error ? error.message : "Could not create organization. Try again.");
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
// SAFETY: /api/v2/metadata returns the MetadataDocument per contract.
        const version = (response as MetadataDocument).version;
        if (isString(version)) {
          const safe = version.replace(/[^A-Za-z0-9._-]/g, "");
          if (safe !== "") setAppVersion(safe);
        }
      })
      .catch((): void => { /* ignore */ });
    return (): void => { controller.abort(); };
  }, []);

  const firstRun = !loading && loadError === "" && organizations.length === 0;

  return (
    <PageShell>
      <PageHeader
        eyebrow="Terrence"
        title={firstRun ? "Welcome to Terrence" : "Organizations"}
        description={firstRun
          ? "A home for your infrastructure, from the first plan to the next change."
          : "Open your infrastructure or create a separate space for another team."}
        action={!firstRun && (
          <Button onClick={(): void => { setCreateError(""); setCreateOpen(true); }}>
            <Plus data-icon="inline-start" />
            New organization
          </Button>
        )}
      />

      {firstRun ? (
        <section aria-labelledby="getting-started-heading" className="grid items-center gap-8 rounded-xl border bg-card p-6 sm:p-10 md:grid-cols-[1fr_auto]">
          <div className="max-w-xl space-y-6">
            <div>
              <h2 id="getting-started-heading" className="text-xl font-semibold tracking-tight">Start small. Make room as you grow.</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">An organization is simply a home for your workspaces. One is enough for most homelabs and small teams.</p>
            </div>
            <ol className="space-y-4 text-sm">
              <li><span className="font-medium">1. Name your organization</span><p className="mt-1 text-muted-foreground">Use your lab or business name, such as homelab.</p></li>
              <li><span className="font-medium">2. Create a workspace</span><p className="mt-1 text-muted-foreground">Keep one set of infrastructure together: your network, servers, or an application.</p></li>
              <li><span className="font-medium">3. Review your first plan</span><p className="mt-1 text-muted-foreground">Connect your code, check the proposed changes, and choose when to apply them.</p></li>
            </ol>
            <Button onClick={(): void => { setCreateError(""); setCreateOpen(true); }}>Create your organization<ArrowRight data-icon="inline-end" /></Button>
          </div>
          <Terrence pose="guide" className="hidden w-48 md:block" />
        </section>
      ) : (
      <>
      <div className="relative max-w-md">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id="organization-search"
          name="organization-search"
          type="search"
          autoComplete="off"
          aria-label="Search organizations"
          className="pl-9"
          placeholder="Search organizations…"
          value={search}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setSearch(event.target.value); }}
        />
      </div>

      {loadError !== "" && organizations.length > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
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
                <TableCell colSpan={3} className="p-0">
                  <TableSkeleton rows={3} cols={3} label="Loading organizations" />
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
                  {organizations.length === 0 ? <Terrence pose="empty" animated className="mx-auto mb-2 w-40" /> : <Building2 aria-hidden="true" className="mx-auto mb-2 size-5" />}
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
                  {organization.attributes["default-iac-binary"] === "tofu" ? "OpenTofu" : "Terraform"}
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

      </>
      )}

      <p className="mt-auto text-xs text-muted-foreground">Terrence{appVersion === "" ? "" : ` v${appVersion}`}</p>

      <Dialog open={createOpen} onOpenChange={(open): void => { if (!saving) setCreateOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create an organization</DialogTitle>
            <DialogDescription>
              Give your infrastructure a home. You can add projects and invite people later.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createOrganization}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="organization-name">Name</FieldLabel>
                <Input
                  id="organization-name"
                  name="organization-name"
                  autoFocus
                  autoComplete="off"
                  placeholder="homelab…"
                  spellCheck={false}
                  value={name}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                />
                {reservedName && (
                  <p role="alert" className="text-sm text-destructive">This name is already used by Terrence. Choose a name other than account, admin, or docs.</p>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="organization-engine">Default engine</FieldLabel>
                <Select id="organization-engine" name="default-iac-binary" value={iacBinary} onValueChange={setIacBinary}>
                  <option value="tofu">OpenTofu</option>
                  <option value="terraform">Terraform</option>
                </Select>
              </Field>
            </FieldGroup>
            {createError !== "" && <p role="alert" className="mt-4 text-sm text-destructive">{createError}</p>}
            <DialogFooter className="mt-6">
              <Button type="button" variant="outline" disabled={saving} onClick={(): void => { setCreateOpen(false); }}>
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
    </PageShell>
  );
}