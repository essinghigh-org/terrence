import { useEffect, useState } from "react";
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

export function WorkspaceNotifications({
  workspaceId,
  mode = "notifications",
}: Readonly<{ workspaceId: string; mode?: "notifications" | "webhooks" }>): React.JSX.Element {
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
  const [enabled, setEnabled] = useState(true);
  const [triggers, setTriggers] = useState<Set<string>>(new Set(["run:completed", "run:errored"]));
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState("");

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setPageError("");
    fetchApi(`/workspaces/${workspaceId}/notification-configurations`)
      .then((response: unknown): void => {
        if (!active) return;
// SAFETY: the fixture matches the JSON:API envelope the component consumes.
        const data = (response as { data?: NotificationConfiguration[] }).data;
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
  }, [workspaceId]);

  const openEditor = (configuration?: NotificationConfiguration): void => {
    setEditing(configuration ?? null);
    setName(configuration?.attributes.name ?? "");
    setDestinationType(configuration?.attributes["destination-type"] ?? "generic");
    setUrl(configuration?.attributes.url ?? "");
    setEmailAddresses(configuration?.attributes["email-addresses"]?.join(", ") ?? "");
    setToken("");
    setEnabled(configuration?.attributes.enabled ?? true);
    setTriggers(new Set(configuration?.attributes.triggers ?? ["run:completed", "run:errored"]));
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
      const response = await fetchApi(
        editing == null
          ? `/workspaces/${workspaceId}/notification-configurations`
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
      ) as { data: NotificationConfiguration };
      const saved = response.data;
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