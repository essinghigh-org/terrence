import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchApi } from "@/lib/api";

type DestinationType = "generic" | "slack" | "microsoft-teams" | "email";

type NotificationConfiguration = {
  id: string;
  attributes: {
    name: string;
    "destination-type": DestinationType;
    url: string;
    "email-addresses"?: string[];
    triggers: string[];
    enabled: boolean;
    token?: string | null;
  };
};

type ProjectWorkspace = Readonly<{ id: string; attributes: Readonly<{ name: string }> }>;
type NotificationProps = Readonly<{
  mode?: "notifications" | "webhooks";
} & (
  | { workspaceId: string; projectId?: never; projectWorkspaces?: never }
  | { projectId: string; projectWorkspaces: readonly ProjectWorkspace[]; workspaceId?: never }
)>;

const triggerOptions = [
  ["run:created", "Run created"],
  ["run:planning", "Run planning"],
  ["run:needs_attention", "Run needs attention"],
  ["run:applying", "Run applying"],
  ["run:completed", "Run completed"],
  ["run:errored", "Run errored"],
  ["assessment:drifted", "Assessment drifted"],
  ["assessment:check_failure", "Assessment check failed"],
  ["assessment:failed", "Assessment failed"],
  ["workspace:auto_destroy_reminder", "Auto-destroy reminder"],
  ["workspace:auto_destroy_run_results", "Auto-destroy results"],
] as const;

const messageFrom = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export function WorkspaceNotifications(props: NotificationProps): React.JSX.Element {
  const mode = props.mode ?? "notifications";
  const projectId = "projectId" in props ? props.projectId ?? null : null;
  const projectWorkspaces = "projectWorkspaces" in props ? props.projectWorkspaces ?? [] : [];
  const scopeEndpoint = "workspaceId" in props
    ? `/workspaces/${props.workspaceId}/notification-configurations`
    : `/projects/${props.projectId}/notification-configurations`;
  const isWebhookMode = mode === "webhooks";
  const [configurations, setConfigurations] = useState<NotificationConfiguration[]>([]);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<NotificationConfiguration | null>(null);
  const [name, setName] = useState("");
  const [destinationType, setDestinationType] = useState<DestinationType>("generic");
  const [url, setUrl] = useState("");
  const [emailAddresses, setEmailAddresses] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [triggers, setTriggers] = useState<Set<string>>(new Set());
  const [excludedWorkspaceIds, setExcludedWorkspaceIds] = useState<Set<string>>(new Set());
  const [originalExcludedWorkspaceIds, setOriginalExcludedWorkspaceIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");

  // Monotonic id for each editor session. A slow exclusion fetch started for
  // one configuration must not apply its result to a different configuration
  // the user opened (or a closed editor) before it resolved.
  const editorGenerationRef = useRef(0);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setPageError("");
    fetchApi<{ data?: NotificationConfiguration[] }>(scopeEndpoint)
      .then((response): void => {
        if (!active) return;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const data = response.data;
        setConfigurations(Array.isArray(data) ? data : []);
      })
      .catch((error: unknown): void => {
        if (active) setPageError(messageFrom(error, "Failed to load notification configurations"));
      })
      .finally((): void => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [scopeEndpoint]);

  const openEditor = (configuration?: NotificationConfiguration): void => {
    const generation = editorGenerationRef.current + 1;
    editorGenerationRef.current = generation;
    setEditing(configuration ?? null);
    setName(configuration?.attributes.name ?? "");
    setDestinationType(configuration?.attributes["destination-type"] ?? "generic");
    setUrl(configuration?.attributes.url ?? "");
    setEmailAddresses(configuration?.attributes["email-addresses"]?.join(", ") ?? "");
    setToken("");
    setEnabled(configuration?.attributes.enabled ?? true);
    setTriggers(new Set(configuration?.attributes.triggers ?? (isWebhookMode ? ["run:completed", "run:errored"] : [])));
    setExcludedWorkspaceIds(new Set());
    setOriginalExcludedWorkspaceIds(new Set());
    if (projectId !== null && configuration !== undefined) {
      void fetchApi<{ data?: { id: string }[] }>(`/notification-configurations/${configuration.id}/relationships/workspaces`)
        .then((response): void => {
          // Only apply when this editor session is still the active one (the
          // user may have opened a different configuration or closed the
          // editor since this request started).
          if (editorGenerationRef.current !== generation) return;
          const ids = new Set((response.data ?? []).map((workspace): string => workspace.id));
          setExcludedWorkspaceIds(ids);
          setOriginalExcludedWorkspaceIds(new Set(ids));
        })
        .catch((error: unknown): void => {
          if (editorGenerationRef.current === generation) {
            setEditorError(messageFrom(error, "Failed to load project workspace exclusions"));
          }
        });
    }
    setEditorError("");
    setEditorOpen(true);
  };

  const toggleTrigger = (trigger: string, checked: boolean): void => {
    setTriggers((current: Set<string>): Set<string> => {
      const next = new Set(current);
      if (checked) next.add(trigger);
      else next.delete(trigger);
      return next;
    });
  };

  const saveConfiguration = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const isEmail = destinationType === "email";
    const addresses = emailAddresses.split(",").map((item: string): string => item.trim()).filter((item: string): boolean => item !== "");
    if (name.trim() === "" || (!isEmail && url.trim() === "") || (isEmail && addresses.length === 0)) {
      setEditorError(isEmail
        ? "Name and at least one email address are required."
        : "Name and webhook URL are required.");
      return;
    }
    const attributes = {
      name: name.trim(),
      "destination-type": destinationType,
      url: isEmail ? "" : url.trim(),
      triggers: [...triggers],
      enabled,
      ...(isEmail ? { "email-addresses": addresses } : undefined),
      ...(token !== "" && !isEmail ? { token } : undefined),
    };

    setSaving(true);
    setEditorError("");
    try {
// SAFETY: the endpoint contract returns the JSON:API envelope with this data shape.
      const response = await fetchApi<{ data: NotificationConfiguration }>(
        editing == null
          ? scopeEndpoint
          : `/notification-configurations/${editing.id}`,
        {
          method: editing == null ? "POST" : "PATCH",
          body: JSON.stringify({
            data: {
              type: "notification-configurations",
              ...(editing == null ? undefined : { id: editing.id }),
              attributes,
            },
          }),
        },
      );
      const saved = response.data;
      if (projectId !== null) {
        const added = [...excludedWorkspaceIds].filter((id): boolean => !originalExcludedWorkspaceIds.has(id));
        const removed = [...originalExcludedWorkspaceIds].filter((id): boolean => !excludedWorkspaceIds.has(id));
        const relationshipPath = `/notification-configurations/${saved.id}/relationships/workspaces`;
        try {
          if (added.length > 0) {
            await fetchApi(relationshipPath, {
              method: "POST",
              body: JSON.stringify({ data: added.map((id): Record<string, string> => ({ id, type: "workspaces" })) }),
            });
          }
          if (removed.length > 0) {
            await fetchApi(relationshipPath, {
              method: "DELETE",
              body: JSON.stringify({ data: removed.map((id): Record<string, string> => ({ id, type: "workspaces" })) }),
            });
          }
        } catch (error: unknown) {
          // The configuration saved but the exclusions are now in an unknown
          // intermediate state (some may have applied, some not). Reload the
          // server's truth before surfacing the failure so a retry is
          // grounded instead of re-applying a blind diff.
          const fresh = await fetchApi<{ data?: { id: string }[] }>(relationshipPath)
            .catch((): { data?: { id: string }[] } => ({}));
          const freshIds = new Set((fresh.data ?? []).map((workspace): string => workspace.id));
          setExcludedWorkspaceIds(freshIds);
          setOriginalExcludedWorkspaceIds(new Set(freshIds));
          setEditorError(messageFrom(error, "Configuration saved, but workspace exclusions could not be fully applied. Review the exclusion list and retry."));
          return;
        }
        setOriginalExcludedWorkspaceIds(new Set(excludedWorkspaceIds));
      }
      setConfigurations((current: NotificationConfiguration[]): NotificationConfiguration[] => {
        const next = editing == null
          ? [...current, saved]
          : current.map((configuration: NotificationConfiguration): NotificationConfiguration =>
              configuration.id === saved.id ? saved : configuration,
            );
        return next.sort((left: NotificationConfiguration, right: NotificationConfiguration): number =>
          left.attributes.name.localeCompare(right.attributes.name),
        );
      });
      setEditorOpen(false);
      setNotice(editing == null ? "Notification configuration created." : "Notification configuration saved.");
    } catch (error: unknown) {
      setEditorError(messageFrom(error, "Failed to save notification configuration"));
    } finally {
      setSaving(false);
    }
  };

  const verifyConfiguration = async (configuration: NotificationConfiguration): Promise<void> => {
    setPageError("");
    setNotice("");
    try {
      await fetchApi(`/notification-configurations/${configuration.id}/actions/verify`, { method: "POST" });
      setNotice(`Verification requested for ${configuration.attributes.name}.`);
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to verify notification configuration"));
    }
  };

  const deleteConfiguration = async (configuration: NotificationConfiguration): Promise<void> => {
    setPageError("");
    setNotice("");
    try {
      await fetchApi(`/notification-configurations/${configuration.id}`, { method: "DELETE" });
      setConfigurations((current: NotificationConfiguration[]): NotificationConfiguration[] =>
        current.filter((item: NotificationConfiguration): boolean => item.id !== configuration.id),
      );
      setNotice("Notification configuration deleted.");
    } catch (error: unknown) {
      setPageError(messageFrom(error, "Failed to delete notification configuration"));
    }
  };

  return (
    <>
      <Card className="max-w-5xl">
        <CardHeader>
          <CardTitle>{isWebhookMode ? "Webhooks" : "Notification configurations"}</CardTitle>
          <CardDescription>
            {isWebhookMode
              ? "Manage destinations for run, assessment, and automatic-destroy events."
              : "Send run, assessment, and automatic-destroy events to a webhook destination."}
          </CardDescription>
          <CardAction>
            <Button onClick={(): void => { openEditor(); }}>
              <Plus data-icon="inline-start" />
              {isWebhookMode ? "Add webhook" : "Add notification"}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {pageError !== "" && <p role="alert" className="text-sm text-destructive">{pageError}</p>}
          {notice !== "" && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Triggers</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                      {isWebhookMode ? "Loading webhooks…" : "Loading notification configurations…"}
                    </TableCell>
                  </TableRow>
                )}
                {!loading && configurations.map((configuration: NotificationConfiguration): React.JSX.Element => (
                  <TableRow key={configuration.id}>
                    <TableCell className="font-medium">{configuration.attributes.name}</TableCell>
                    <TableCell>{configuration.attributes["destination-type"]}</TableCell>
                    <TableCell>{configuration.attributes.triggers.length}</TableCell>
                    <TableCell>
                      <Badge variant={configuration.attributes.enabled ? "secondary" : "outline"}>
                        {configuration.attributes.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(): void => { void verifyConfiguration(configuration); }}
                        >
                          Verify
                        </Button>
                        <Button size="sm" variant="outline" onClick={(): void => { openEditor(configuration); }}>
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={(): void => { void deleteConfiguration(configuration); }}
                        >
                          Delete
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {!loading && configurations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                      {isWebhookMode ? "No webhooks have been added." : "No notification configurations have been added."}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing == null
              ? (isWebhookMode ? "Add webhook" : "Add notification")
              : (isWebhookMode ? "Edit webhook" : "Edit notification")}</DialogTitle>
            <DialogDescription>
              Choose a webhook destination and the events it should receive.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveConfiguration} noValidate>
            <FieldGroup>
              <Field data-invalid={editorError !== "" && name.trim() === ""}>
                <FieldLabel htmlFor="notification-name">Name</FieldLabel>
                <Input
                  id="notification-name"
                  name="notification-name"
                  autoComplete="off"
                  spellCheck={false}
                  value={name}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setName(event.target.value); }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setName(event.currentTarget.value); }}
                  aria-invalid={editorError !== "" && name.trim() === ""}
                  autoFocus
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="notification-destination">Destination type</FieldLabel>
                <Select
                  id="notification-destination"
                  name="destination-type"
                  value={destinationType}
// SAFETY: the select options are generated from the same union; the change event carries one of them.
                  onValueChange={(value: string): void => {

                    // SAFETY: the change event carries one of the union values the UI renders from the same options.

                    setDestinationType(value as DestinationType);

                  }}
                >
                  <SelectItem value="generic">Generic webhook</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="microsoft-teams">Microsoft Teams</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                </Select>
              </Field>
              {destinationType === "email" ? (
                <Field data-invalid={editorError !== "" && emailAddresses.trim() === ""}>
                  <FieldLabel htmlFor="notification-email-addresses">Email addresses</FieldLabel>
                  <Input
                    id="notification-email-addresses"
                    name="email-addresses"
                    autoComplete="off"
                    type="email"
                    value={emailAddresses}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setEmailAddresses(event.target.value); }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setEmailAddresses(event.currentTarget.value); }}
                    aria-invalid={editorError !== "" && emailAddresses.trim() === ""}
                    placeholder="team@example.com, oncall@example.com"
                  />
                  <FieldDescription>Comma-separated recipients. Delivered via the SMTP settings.</FieldDescription>
                </Field>
              ) : (
                <Field data-invalid={editorError !== "" && url.trim() === ""}>
                  <FieldLabel htmlFor="notification-url">Webhook URL</FieldLabel>
                  <Input
                    id="notification-url"
                    name="webhook-url"
                    autoComplete="url"
                    type="url"
                    value={url}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setUrl(event.target.value); }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setUrl(event.currentTarget.value); }}
                    aria-invalid={editorError !== "" && url.trim() === ""}
                    placeholder="https://example.com/webhook"
                  />
                </Field>
              )}
              {destinationType !== "email" && (
                <Field>
                  <FieldLabel htmlFor="notification-token">Token</FieldLabel>
                  <Input
                    id="notification-token"
                    name="webhook-token"
                    type="password"
                    value={token}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => { setToken(event.target.value); }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => { setToken(event.currentTarget.value); }}
                    autoComplete="new-password"
                  />
                  <FieldDescription>
                    {editing == null ? "Optional bearer token." : "Leave blank to keep the current token."}
                  </FieldDescription>
                </Field>
              )}
              <Field orientation="horizontal">
                <Checkbox
                  id="notification-enabled"
                  checked={enabled}
                  onCheckedChange={(checked: boolean): void => { setEnabled(checked); }}
                />
                <FieldContent>
                  <FieldLabel htmlFor="notification-enabled">Enabled</FieldLabel>
                  <FieldDescription>Deliver matching events to this destination.</FieldDescription>
                </FieldContent>
              </Field>
              <FieldSet>
                <FieldLegend variant="label">Triggers</FieldLegend>
                <FieldGroup className="grid gap-3 sm:grid-cols-2">
                  {triggerOptions.map(([trigger, label]): React.JSX.Element => (
                    <Field key={trigger} orientation="horizontal">
                      <Checkbox
                        id={`notification-trigger-${trigger}`}
                        checked={triggers.has(trigger)}
                        onCheckedChange={(checked: boolean): void => { toggleTrigger(trigger, checked); }}
                      />
                      <FieldLabel htmlFor={`notification-trigger-${trigger}`}>{label}</FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
              {projectId !== null && projectWorkspaces.length > 0 && (
                <FieldSet>
                  <FieldLegend variant="label">Excluded workspaces</FieldLegend>
                  <FieldDescription>Do not deliver this project notification for selected workspaces.</FieldDescription>
                  <FieldGroup className="grid gap-3 sm:grid-cols-2">
                    {projectWorkspaces.map((workspace): React.JSX.Element => (
                      <Field key={workspace.id} orientation="horizontal">
                        <Checkbox
                          id={`notification-excluded-${workspace.id}`}
                          checked={excludedWorkspaceIds.has(workspace.id)}
                          onCheckedChange={(checked: boolean): void => {
                            setExcludedWorkspaceIds((current): Set<string> => {
                              const next = new Set(current);
                              if (checked) next.add(workspace.id);
                              else next.delete(workspace.id);
                              return next;
                            });
                          }}
                        />
                        <FieldLabel htmlFor={`notification-excluded-${workspace.id}`}>{workspace.attributes.name}</FieldLabel>
                      </Field>
                    ))}
                  </FieldGroup>
                </FieldSet>
              )}
              <FieldError>{editorError}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={(): void => { setEditorOpen(false); }}>
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving && <Spinner data-icon="inline-start" />}
                  {saving ? "Saving" : (isWebhookMode ? "Save webhook" : "Save notification")}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
