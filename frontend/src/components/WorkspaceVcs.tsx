import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Spinner } from "@/components/ui/spinner";
import { fetchApi } from "@/lib/api";

type VcsRepo = {
  identifier?: string;
  branch?: string;
  oauthTokenId?: string;
  githubAppInstallationId?: string;
  ingressSubmodules?: boolean;
  tagsRegex?: string;
};

export type VcsWorkspace = {
  id: string;
  attributes: {
    name: string;
    "vcs-repo"?: VcsRepo | null;
    "working-directory"?: string | null;
    "auto-apply"?: boolean;
    "file-triggers-enabled"?: boolean;
    "trigger-prefixes"?: string[];
    "trigger-patterns"?: string[];
    "speculative-enabled"?: boolean;
    permissions?: { "can-update"?: boolean };
    [key: string]: unknown;
  };
};

const entries = (value: string): string[] =>
  value.split(/[\r\n,]+/).map((entry: string): string => entry.trim()).filter(Boolean);

export function WorkspaceVcs({
  workspace,
  onSaved,
}: Readonly<{
  workspace: VcsWorkspace;
  onSaved: (workspace: VcsWorkspace) => void;
}>): React.JSX.Element {
  const initialRepo = workspace.attributes["vcs-repo"] ?? null;
  const [connected, setConnected] = useState(initialRepo !== null);
  const [identifier, setIdentifier] = useState(initialRepo?.identifier ?? "");
  const [branch, setBranch] = useState(initialRepo?.branch ?? "");
  const [githubAppInstallationId, setGithubAppInstallationId] = useState(
    initialRepo?.githubAppInstallationId ?? "",
  );
  const [oauthTokenId, setOauthTokenId] = useState(initialRepo?.oauthTokenId ?? "");
  const [workingDirectory, setWorkingDirectory] = useState(
    workspace.attributes["working-directory"] ?? "",
  );
  const [tagsRegex, setTagsRegex] = useState(initialRepo?.tagsRegex ?? "");
  const [triggerPrefixes, setTriggerPrefixes] = useState(
    (workspace.attributes["trigger-prefixes"] ?? []).join(", "),
  );
  const [triggerPatterns, setTriggerPatterns] = useState(
    (workspace.attributes["trigger-patterns"] ?? []).join(", "),
  );
  const [ingressSubmodules, setIngressSubmodules] = useState(
    initialRepo?.ingressSubmodules === true,
  );
  const [autoApply, setAutoApply] = useState(workspace.attributes["auto-apply"] === true);
  const [fileTriggersEnabled, setFileTriggersEnabled] = useState(
    workspace.attributes["file-triggers-enabled"] !== false,
  );
  const [speculativeEnabled, setSpeculativeEnabled] = useState(
    workspace.attributes["speculative-enabled"] !== false,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const canUpdate = workspace.attributes.permissions?.["can-update"] !== false;

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const normalizedIdentifier = identifier.trim();
    const normalizedInstallationId = githubAppInstallationId.trim();
    const normalizedOauthTokenId = oauthTokenId.trim();
    if (normalizedIdentifier === "") {
      setError("Repository identifier is required.");
      return;
    }
    if ((normalizedInstallationId === "") === (normalizedOauthTokenId === "")) {
      setError("Provide exactly one GitHub App installation ID or OAuth token ID.");
      return;
    }

    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            attributes: {
              "vcs-repo": {
                identifier: normalizedIdentifier,
                branch: branch.trim() === "" ? null : branch.trim(),
                "github-app-installation-id": normalizedInstallationId === "" ? null : normalizedInstallationId,
                "oauth-token-id": normalizedOauthTokenId === "" ? null : normalizedOauthTokenId,
                "ingress-submodules": ingressSubmodules,
                "tags-regex": tagsRegex.trim() === "" ? null : tagsRegex.trim(),
              },
              "working-directory": workingDirectory.trim(),
              "auto-apply": autoApply,
              "file-triggers-enabled": fileTriggersEnabled,
              "trigger-prefixes": entries(triggerPrefixes),
              "trigger-patterns": entries(triggerPatterns),
              "speculative-enabled": speculativeEnabled,
            },
          },
        }),
      }) as { data: VcsWorkspace };
      onSaved(response.data);
      setConnected(true);
      setSaved(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to save VCS settings");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (!window.confirm("Disconnect this workspace from version control?")) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            attributes: { "vcs-repo": null },
          },
        }),
      }) as { data: VcsWorkspace };
      onSaved(response.data);
      setConnected(false);
      setSaved(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to disconnect VCS");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="max-w-4xl">
      <Card>
        <CardHeader>
          <CardTitle>Version control</CardTitle>
          <CardAction>
            <Badge variant={connected ? "default" : "secondary"}>
              {connected ? "Connected" : "Not connected"}
            </Badge>
          </CardAction>
          <CardDescription>
            Configure the repository source and the changes that trigger workspace runs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="vcs-identifier">Repository identifier</FieldLabel>
              <Input
                id="vcs-identifier"
                value={identifier}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setIdentifier(event.target.value);
                }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                  setIdentifier(event.currentTarget.value);
                }}
                placeholder="organization/repository"
                disabled={!canUpdate}
              />
              <FieldDescription>The namespace and repository that contains this configuration.</FieldDescription>
            </Field>
            <FieldSet disabled={!canUpdate}>
              <FieldLegend variant="label">VCS connection</FieldLegend>
              <FieldDescription>Provide exactly one registered VCS connection ID.</FieldDescription>
              <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
                <Field data-disabled={!canUpdate}>
                  <FieldLabel htmlFor="vcs-github-app">GitHub App installation ID</FieldLabel>
                  <Input
                    id="vcs-github-app"
                    value={githubAppInstallationId}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                      setGithubAppInstallationId(event.target.value);
                    }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                      setGithubAppInstallationId(event.currentTarget.value);
                    }}
                    placeholder="ghain-..."
                    disabled={!canUpdate}
                  />
                </Field>
                <Field data-disabled={!canUpdate}>
                  <FieldLabel htmlFor="vcs-oauth-token">OAuth token ID</FieldLabel>
                  <Input
                    id="vcs-oauth-token"
                    value={oauthTokenId}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                      setOauthTokenId(event.target.value);
                    }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                      setOauthTokenId(event.currentTarget.value);
                    }}
                    placeholder="ot-..."
                    disabled={!canUpdate}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-branch">VCS branch</FieldLabel>
                <Input
                  id="vcs-branch"
                  value={branch}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setBranch(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setBranch(event.currentTarget.value);
                  }}
                  placeholder="Default branch"
                  disabled={!canUpdate}
                />
              </Field>
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-working-directory">Terraform working directory</FieldLabel>
                <Input
                  id="vcs-working-directory"
                  value={workingDirectory}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setWorkingDirectory(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setWorkingDirectory(event.currentTarget.value);
                  }}
                  placeholder="Root of repository"
                  disabled={!canUpdate}
                />
              </Field>
            </FieldGroup>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="vcs-tags-regex">Git tag regular expression</FieldLabel>
              <Input
                id="vcs-tags-regex"
                value={tagsRegex}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setTagsRegex(event.target.value);
                }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                  setTagsRegex(event.currentTarget.value);
                }}
                placeholder="^v\d+\.\d+\.\d+$"
                disabled={!canUpdate}
              />
              <FieldDescription>When set, matching tags trigger runs regardless of the branch.</FieldDescription>
            </Field>
            <FieldGroup className="grid gap-5 @md/field-group:grid-cols-2">
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-trigger-prefixes">Trigger prefixes</FieldLabel>
                <Input
                  id="vcs-trigger-prefixes"
                  value={triggerPrefixes}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setTriggerPrefixes(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setTriggerPrefixes(event.currentTarget.value);
                  }}
                  placeholder="modules, services/api"
                  disabled={!canUpdate}
                />
                <FieldDescription>Separate repository paths with commas.</FieldDescription>
              </Field>
              <Field data-disabled={!canUpdate}>
                <FieldLabel htmlFor="vcs-trigger-patterns">Trigger patterns</FieldLabel>
                <Input
                  id="vcs-trigger-patterns"
                  value={triggerPatterns}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                    setTriggerPatterns(event.target.value);
                  }}
                  onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                    setTriggerPatterns(event.currentTarget.value);
                  }}
                  placeholder="modules/**/*.tf, shared/**/*.tf"
                  disabled={!canUpdate}
                />
                <FieldDescription>Separate glob patterns with commas.</FieldDescription>
              </Field>
            </FieldGroup>
            <FieldSet disabled={!canUpdate}>
              <FieldLegend variant="label">Run behavior</FieldLegend>
              <FieldGroup className="gap-3">
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-file-triggers"
                    checked={fileTriggersEnabled}
                    onCheckedChange={(checked: boolean): void => { setFileTriggersEnabled(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-file-triggers">Filter runs by changed files</FieldLabel>
                    <FieldDescription>Use the configured paths and patterns to decide when to run.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-speculative"
                    checked={speculativeEnabled}
                    onCheckedChange={(checked: boolean): void => { setSpeculativeEnabled(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-speculative">Automatic speculative plans</FieldLabel>
                    <FieldDescription>Plan pull requests before they are merged.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-auto-apply"
                    checked={autoApply}
                    onCheckedChange={(checked: boolean): void => { setAutoApply(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-auto-apply">Auto-apply successful plans</FieldLabel>
                    <FieldDescription>Apply VCS runs without waiting for manual confirmation.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="vcs-submodules"
                    checked={ingressSubmodules}
                    onCheckedChange={(checked: boolean): void => { setIngressSubmodules(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="vcs-submodules">Include submodules when cloning</FieldLabel>
                    <FieldDescription>Recursively fetch Git submodules with the repository.</FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="destructive"
              onClick={(): void => { void disconnect(); }}
              disabled={!connected || saving || !canUpdate}
            >
              Disconnect
            </Button>
            <span role="status" className="text-sm text-muted-foreground">
              {saved ? "VCS settings saved." : canUpdate ? "" : "You cannot update this workspace."}
            </span>
          </div>
          <Button type="submit" disabled={saving || !canUpdate}>
            {saving && <Spinner data-icon="inline-start" />}
            {saving ? "Saving" : connected ? "Save VCS settings" : "Connect repository"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
