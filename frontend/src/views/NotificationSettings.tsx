import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Field, FieldGroup, FieldLabel } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { toast } from "../components/ui/toast";
import { Trash2, Plus, Bell, Send, FileText, History, TestTube } from "lucide-react";
import { ConfirmDialog } from "../components/ui/confirm-dialog";

type Destination = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    type: "slack" | "discord" | "sendgrid" | "apprise-custom";
    config: Readonly<Record<string, string | null>>;
    enabled: boolean;
  }>;
}>;
type Rule = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    "event-type": string;
    "workspace-tag-filters": readonly { key: string; value: string }[];
    "destination-id": string;
    "template-id": string | null;
    enabled: boolean;
  }>;
}>;
type Template = Readonly<{
  id: string;
  attributes: Readonly<{
    name: string;
    "event-type": string;
    "title-template": string;
    "body-template": string;
  }>;
}>;
type Delivery = Readonly<{
  id: string;
  attributes: Readonly<{
    "event-type": string;
    "destination-id": string;
    "workspace-id": string | null;
    title: string | null;
    body: string;
    successful: boolean;
    error: string | null;
    attempts: number;
    "created-at": string;
  }>;
}>;

const EVENT_TYPES = [
  "workspace.run.started",
  "workspace.plan.completed",
  "workspace.plan.failed",
  "workspace.apply.completed",
  "workspace.apply.failed",
  "workspace.drift.detected",
  "workspace.lock.created",
  "workspace.variable.changed",
  "workspace.vcs.run.triggered",
];

const DESTINATION_TYPES = [
  { value: "slack", label: "Slack" },
  { value: "discord", label: "Discord" },
  { value: "sendgrid", label: "SendGrid (Email)" },
  { value: "apprise-custom", label: "Apprise (Custom)" },
];

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

const emptyConfig = (type: string): Record<string, string> => {
  switch (type) {
    case "slack": return { token: "", channel: "" };
    case "discord": return { webhookUrl: "" };
    case "sendgrid": return { apiKey: "", fromEmail: "", toEmail: "" };
    default: return { url: "" };
  }
};

const configLabels: Record<string, Record<string, string>> = {
  slack: { token: "Bot Token (xoxb-...)", channel: "Channel (e.g. #alerts)" },
  discord: { webhookUrl: "Webhook URL" },
  sendgrid: { apiKey: "SendGrid API Key", fromEmail: "From Email", toEmail: "To Email" },
  "apprise-custom": { url: "Apprise URL (e.g. tgram://bot/chat)" },
};

export function NotificationSettings(): React.JSX.Element {
  const { orgName: orgNameParam } = useParams();
  const orgName = orgNameParam ?? "";
  const [tab, setTab] = useState<"destinations" | "rules" | "templates" | "deliveries">("destinations");
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Destination editor state
  const [destOpen, setDestOpen] = useState(false);
  const [destName, setDestName] = useState("");
  const [destType, setDestType] = useState("slack");
  const [destConfig, setDestConfig] = useState<Record<string, string>>({});
  const [destSaving, setDestSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  // Rule editor state
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleName, setRuleName] = useState("");
  const [ruleEvent, setRuleEvent] = useState<string>(EVENT_TYPES[0] ?? "workspace.run.started");
  const [ruleDest, setRuleDest] = useState("");
  const [ruleTpl, setRuleTpl] = useState("");
  const [ruleFilters, setRuleFilters] = useState<{ key: string; value: string }[]>([]);
  const [ruleSaving, setRuleSaving] = useState(false);

  // Template editor state
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplEvent, setTplEvent] = useState<string>(EVENT_TYPES[0] ?? "workspace.run.started");
  const [tplTitle, setTplTitle] = useState("");
  const [tplBody, setTplBody] = useState("");
  const [tplSaving, setTplSaving] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<{ kind: "destination" | "rule" | "template"; id: string } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (orgName === "") return;
    setLoading(true);
    setError("");
    try {
      const [d, r, t, dl] = await Promise.all([
        fetchApi(`/organizations/${orgName}/notification-destinations`),
        fetchApi(`/organizations/${orgName}/notification-rules`),
        fetchApi(`/organizations/${orgName}/notification-templates`),
        fetchApi(`/organizations/${orgName}/notification-deliveries`),
      ]);
      setDestinations((d as { data?: Destination[] }).data ?? []);
      setRules((r as { data?: Rule[] }).data ?? []);
      setTemplates((t as { data?: Template[] }).data ?? []);
      setDeliveries((dl as { data?: Delivery[] }).data ?? []);
    } catch (err: unknown) {
      setError(messageFrom(err, "Failed to load notifications"));
    } finally {
      setLoading(false);
    }
  }, [orgName]);

  useEffect((): (() => void) => {
    void load();
    return (): void => { /* effect cleanup */ };
  }, [load]);

  const saveDestination = async (): Promise<void> => {
    setDestSaving(true);
    try {
      const config = { ...destConfig };
      await fetchApi(`/organizations/${orgName}/notification-destinations`, {
        method: "POST",
        body: JSON.stringify({
          data: { attributes: { name: destName, type: destType, config } },
        }),
      });
      toast.add({ title: "Destination created", type: "success" });
      setDestOpen(false);
      setDestName("");
      setDestConfig({});
      await load();
    } catch (err: unknown) {
      toast.add({ title: "Notification error", description: messageFrom(err, "Failed to create destination"), type: "error" });
    } finally {
      setDestSaving(false);
    }
  };

  const testDestination = async (id: string): Promise<void> => {
    setTestingId(id);
    try {
      const res = (await fetchApi(`/organizations/${orgName}/notification-destinations/${id}/test`, {
        method: "POST",
      })) as { data: { attributes: { successful: boolean; error: string | null } } };
      const attrs = res.data.attributes;
      if (attrs.successful) toast.add({ title: "Test notification sent", type: "success" });
      else toast.add({ title: "Notification error", description: `Test failed: ${attrs.error ?? "unknown error"}`, type: "error" });
    } catch (err: unknown) {
      toast.add({ title: "Notification error", description: messageFrom(err, "Test failed"), type: "error" });
    } finally {
      setTestingId(null);
    }
  };

  const deleteDestination = async (id: string): Promise<void> => {
    await fetchApi(`/organizations/${orgName}/notification-destinations/${id}`, { method: "DELETE" });
    toast.add({ title: "Destination deleted", type: "success" });
    setConfirmDelete(null);
    await load();
  };

  const saveRule = async (): Promise<void> => {
    setRuleSaving(true);
    try {
      const attributes: Record<string, unknown> = {
        name: ruleName,
        "event-type": ruleEvent,
        "destination-id": ruleDest,
        "workspace-tag-filters": ruleFilters,
      };
      if (ruleTpl !== "") attributes["template-id"] = ruleTpl;
      await fetchApi(`/organizations/${orgName}/notification-rules`, {
        method: "POST",
        body: JSON.stringify({ data: { attributes } }),
      });
      toast.add({ title: "Rule created", type: "success" });
      setRuleOpen(false);
      setRuleName("");
      setRuleFilters([]);
      setRuleTpl("");
      await load();
    } catch (err: unknown) {
      toast.add({ title: "Notification error", description: messageFrom(err, "Failed to create rule"), type: "error" });
    } finally {
      setRuleSaving(false);
    }
  };

  const deleteRule = async (id: string): Promise<void> => {
    await fetchApi(`/organizations/${orgName}/notification-rules/${id}`, { method: "DELETE" });
    toast.add({ title: "Rule deleted", type: "success" });
    setConfirmDelete(null);
    await load();
  };

  const saveTemplate = async (): Promise<void> => {
    setTplSaving(true);
    try {
      await fetchApi(`/organizations/${orgName}/notification-templates`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            attributes: {
              name: tplName,
              "event-type": tplEvent,
              "title-template": tplTitle,
              "body-template": tplBody,
            },
          },
        }),
      });
      toast.add({ title: "Template created", type: "success" });
      setTplOpen(false);
      setTplName("");
      setTplTitle("");
      setTplBody("");
      await load();
    } catch (err: unknown) {
      toast.add({ title: "Notification error", description: messageFrom(err, "Failed to create template"), type: "error" });
    } finally {
      setTplSaving(false);
    }
  };

  const deleteTemplate = async (id: string): Promise<void> => {
    await fetchApi(`/organizations/${orgName}/notification-templates/${id}`, { method: "DELETE" });
    toast.add({ title: "Template deleted", type: "success" });
    setConfirmDelete(null);
    await load();
  };

  const tabs = [
    { id: "destinations" as const, label: "Destinations", icon: Send },
    { id: "rules" as const, label: "Rules", icon: Bell },
    { id: "templates" as const, label: "Templates", icon: FileText },
    { id: "deliveries" as const, label: "Deliveries", icon: History },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Notifications</h1>
        <p className="text-neutral-400">
          Alert destinations, delivery rules, message templates, and delivery history for {orgName}.
        </p>
      </div>

      <div className="flex gap-1 border-b border-neutral-800">
        {tabs.map((t): React.JSX.Element => (
          <button
            key={t.id}
            type="button"
            onClick={(): void => { setTab(t.id); }}
            className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "border-b-2 border-sky-400 text-sky-400"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            <t.icon className="size-4" />
            {t.label}
          </button>
        ))}
      </div>

      {error !== "" && <p className="text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="text-neutral-400">Loading…</p>
      ) : (
        <>
          {tab === "destinations" && (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle>Notification Destinations</CardTitle>
                  <CardDescription>Where alerts are sent. Apprise (Custom) accepts any supported Apprise URL.</CardDescription>
                </div>
                <Button onClick={(): void => { setDestOpen(true); setDestType("slack"); setDestConfig(emptyConfig("slack")); }}>
                  <Plus className="size-4" /> New Destination
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {destinations.map((d): React.JSX.Element => (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.attributes.name}</TableCell>
                        <TableCell>{d.attributes.type}</TableCell>
                        <TableCell>{d.attributes.enabled ? "Enabled" : "Disabled"}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" size="sm" onClick={async (): Promise<void> => { await testDestination(d.id); }} disabled={testingId === d.id}>
                              <TestTube className="size-3" /> {testingId === d.id ? "Sending…" : "Test"}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={(): void => { setConfirmDelete({ kind: "destination", id: d.id }); }}>
                              <Trash2 className="size-3 text-red-400" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                    {destinations.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center text-neutral-500">No destinations yet.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {tab === "rules" && (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle>Notification Rules</CardTitle>
                  <CardDescription>IF event matches AND workspace tags match THEN notify the destination.</CardDescription>
                </div>
                <Button onClick={(): void => {
                  setRuleOpen(true);
                  setRuleEvent(EVENT_TYPES[0] ?? "workspace.run.started");
                  setRuleDest(destinations[0]?.id ?? "");
                }}>
                  <Plus className="size-4" /> New Rule
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Tag Filters</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((r): React.JSX.Element => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.attributes.name}</TableCell>
                        <TableCell className="font-mono text-xs">{r.attributes["event-type"]}</TableCell>
                        <TableCell>
                          {r.attributes["workspace-tag-filters"].length === 0
                            ? "All workspaces"
                            : r.attributes["workspace-tag-filters"].map((f): string => `${f.key}=${f.value}`).join(", ")}
                        </TableCell>
                        <TableCell>{r.attributes.enabled ? "Enabled" : "Disabled"}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={(): void => { setConfirmDelete({ kind: "rule", id: r.id }); }}>
                            <Trash2 className="size-3 text-red-400" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {rules.length === 0 && (
                      <TableRow><TableCell colSpan={5} className="text-center text-neutral-500">No rules yet.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {tab === "templates" && (
            <Card>
              <CardHeader className="flex-row items-center justify-between">
                <div>
                  <CardTitle>Message Templates</CardTitle>
                  <CardDescription>Customize title and body with placeholders like {"{{workspace.name}}"}, {"{{run.message}}"}, {"{{run.url}}"}.</CardDescription>
                </div>
                <Button onClick={(): void => { setTplOpen(true); setTplEvent(EVENT_TYPES[0] ?? "workspace.run.started"); }}>
                  <Plus className="size-4" /> New Template
                </Button>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {templates.map((t): React.JSX.Element => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.attributes.name}</TableCell>
                        <TableCell className="font-mono text-xs">{t.attributes["event-type"]}</TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={(): void => { setConfirmDelete({ kind: "template", id: t.id }); }}>
                            <Trash2 className="size-3 text-red-400" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {templates.length === 0 && (
                      <TableRow><TableCell colSpan={3} className="text-center text-neutral-500">No custom templates — defaults are used per event.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {tab === "deliveries" && (
            <Card>
              <CardHeader>
                <CardTitle>Delivery History</CardTitle>
                <CardDescription>Every notification attempt and its outcome.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Title</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {deliveries.map((dl): React.JSX.Element => (
                      <TableRow key={dl.id}>
                        <TableCell className="text-xs text-neutral-400">{new Date(dl.attributes["created-at"]).toLocaleString()}</TableCell>
                        <TableCell className="font-mono text-xs">{dl.attributes["event-type"]}</TableCell>
                        <TableCell>{dl.attributes.title ?? "—"}</TableCell>
                        <TableCell>
                          {dl.attributes.successful
                            ? <span className="text-emerald-400">Delivered</span>
                            : <span className="text-red-400" title={dl.attributes.error ?? ""}>Failed</span>}
                        </TableCell>
                      </TableRow>
                    ))}
                    {deliveries.length === 0 && (
                      <TableRow><TableCell colSpan={4} className="text-center text-neutral-500">No deliveries yet.</TableCell></TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Destination editor */}
      {destOpen && (
        <Card className="fixed inset-0 z-50 m-auto flex h-fit max-h-[90vh] w-[28rem] max-w-[95vw] flex-col overflow-y-auto">
          <CardHeader>
            <CardTitle>New Destination</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input value={destName} onChange={(e): void => { setDestName(e.target.value); }} placeholder="Production Alerts" />
              </Field>
              <Field>
                <FieldLabel>Type</FieldLabel>
                <Select
                  value={destType}
                  onValueChange={(value): void => {
                    setDestType(value);
                    setDestConfig(emptyConfig(value));
                  }}
                >
                  {DESTINATION_TYPES.map((t): React.JSX.Element => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              </Field>
              {Object.entries(configLabels[destType] ?? {}).map(([key, label]): React.JSX.Element => (
                <Field key={key}>
                  <FieldLabel>{label}</FieldLabel>
                  <Input
                    value={destConfig[key] ?? ""}
                    onChange={(e): void => { setDestConfig((prev: Record<string, string>): Record<string, string> => ({ ...prev, [key]: e.target.value })); }}
                  />
                </Field>
              ))}
            </FieldGroup>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={(): void => { setDestOpen(false); }}>Cancel</Button>
              <Button onClick={async (): Promise<void> => { await saveDestination(); }} disabled={destSaving || destName === ""}>
                {destSaving ? "Saving…" : "Create"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Rule editor */}
      {ruleOpen && (
        <Card className="fixed inset-0 z-50 m-auto flex h-fit max-h-[90vh] w-[32rem] max-w-[95vw] flex-col overflow-y-auto">
          <CardHeader>
            <CardTitle>New Rule</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input value={ruleName} onChange={(e): void => { setRuleName(e.target.value); }} placeholder="Production apply failures" />
              </Field>
              <Field>
                <FieldLabel>Event</FieldLabel>
                <Select value={ruleEvent} onValueChange={(value): void => { setRuleEvent(value); }}>
                  {EVENT_TYPES.map((ev): React.JSX.Element => <option key={ev} value={ev}>{ev}</option>)}
                </Select>
              </Field>
              <Field>
                <FieldLabel>Destination</FieldLabel>
                <Select value={ruleDest} onValueChange={(value): void => { setRuleDest(value); }}>
                  {destinations.map((d): React.JSX.Element => <option key={d.id} value={d.id}>{d.attributes.name}</option>)}
                </Select>
              </Field>
              <Field>
                <FieldLabel>Template (optional — defaults used when empty)</FieldLabel>
                <Select value={ruleTpl} onValueChange={(value): void => { setRuleTpl(value); }}>
                  <option value="">Default</option>
                  {templates.map((t): React.JSX.Element => <option key={t.id} value={t.id}>{t.attributes.name}</option>)}
                </Select>
              </Field>
              <Field>
                <FieldLabel>Workspace tag filters (all must match)</FieldLabel>
                {ruleFilters.map((filter, index): React.JSX.Element => (
                  <div key={index} className="flex gap-2">
                    <Input
                      placeholder="key (e.g. environment)"
                      value={filter.key}
                      onChange={(e): void => setRuleFilters((prev) => prev.map((f, i) => i === index ? { ...f, key: e.target.value } : f))}
                    />
                    <Input
                      placeholder="value (e.g. production)"
                      value={filter.value}
                      onChange={(e): void => setRuleFilters((prev) => prev.map((f, i) => i === index ? { ...f, value: e.target.value } : f))}
                    />
                    <Button variant="ghost" size="sm" onClick={(): void => setRuleFilters((prev) => prev.filter((_, i) => i !== index))}>
                      <Trash2 className="size-3 text-red-400" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={(): void => setRuleFilters((prev) => [...prev, { key: "", value: "" }])}>
                  <Plus className="size-3" /> Add filter
                </Button>
              </Field>
            </FieldGroup>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={(): void => { setRuleOpen(false); }}>Cancel</Button>
              <Button onClick={async (): Promise<void> => { await saveRule(); }} disabled={ruleSaving || ruleName === "" || ruleDest === ""}>
                {ruleSaving ? "Saving…" : "Create"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Template editor */}
      {tplOpen && (
        <Card className="fixed inset-0 z-50 m-auto flex h-fit max-h-[90vh] w-[34rem] max-w-[95vw] flex-col overflow-y-auto">
          <CardHeader>
            <CardTitle>New Template</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FieldGroup>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input value={tplName} onChange={(e): void => { setTplName(e.target.value); }} placeholder="Run Failed" />
              </Field>
              <Field>
                <FieldLabel>Event</FieldLabel>
                <Select value={tplEvent} onValueChange={(value): void => { setTplEvent(value); }}>
                  {EVENT_TYPES.map((ev): React.JSX.Element => <option key={ev} value={ev}>{ev}</option>)}
                </Select>
              </Field>
              <Field>
                <FieldLabel>Title</FieldLabel>
                <Input value={tplTitle} onChange={(e): void => { setTplTitle(e.target.value); }} placeholder="Apply Failed: {{workspace.name}}" />
              </Field>
              <Field>
                <FieldLabel>Body</FieldLabel>
                <textarea
                  className="min-h-40 w-full rounded-md border border-neutral-700 bg-neutral-900 p-2 font-mono text-sm"
                  value={tplBody}
                  onChange={(e): void => { setTplBody(e.target.value); }}
                  placeholder={"Workspace: {{workspace.name}}\nCommit: {{run.commitSha}}\nError: {{run.message}}\nView: {{run.url}}"}
                />
              </Field>
              <p className="text-xs text-neutral-500">
                Placeholders: {"{{workspace.name}}"}, {"{{workspace.tags.*}}"}, {"{{run.id}}"}, {"{{run.message}}"}, {"{{run.commitSha}}"}, {"{{run.url}}"}, {"{{drift.resourcesDrifted}}"}, {"{{variable.key}}"}, {"{{lock.createdBy}}"}
              </p>
            </FieldGroup>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={(): void => { setTplOpen(false); }}>Cancel</Button>
              <Button onClick={async (): Promise<void> => { await saveTemplate(); }} disabled={tplSaving || tplName === "" || tplTitle === "" || tplBody === ""}>
                {tplSaving ? "Saving…" : "Create"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open): void => { if (!open) setConfirmDelete(null); }}
        title="Delete?"
        description="This cannot be undone. Rules and deliveries referencing it will be affected."
        confirmText="Delete"
        onConfirm={(): Promise<void> => {
          if (confirmDelete === null) return Promise.resolve();
          if (confirmDelete.kind === "destination") return deleteDestination(confirmDelete.id);
          if (confirmDelete.kind === "rule") return deleteRule(confirmDelete.id);
          return deleteTemplate(confirmDelete.id);
        }}
      />
    </div>
  );
}
