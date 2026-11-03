import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { ApiError, fetchApi } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

type CredentialRefs = Readonly<{
  patRef: RefObject<HTMLInputElement | null>;
  webhookSecretRef: RefObject<HTMLInputElement | null>;
}>;

export function clearAzureDevOpsCredentials({ patRef, webhookSecretRef }: CredentialRefs): void {
  if (patRef.current !== null) patRef.current.value = "";
  if (webhookSecretRef.current !== null) webhookSecretRef.current.value = "";
}

export function takeAzureDevOpsCredentials(
  organization: string,
  refs: CredentialRefs,
  requireWebhookSecret: boolean,
): Readonly<{ "ado-org-name": string; "oauth-token": string; secret?: string }> {
  const pat = refs.patRef.current?.value.trim() ?? "";
  const secret = refs.webhookSecretRef.current?.value.trim() ?? "";
  // Never retain submitted credentials in the form, including after an error.
  clearAzureDevOpsCredentials(refs);
  const orgName = organization.trim().toLowerCase();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?$/.test(orgName)) {
    throw new Error(
      "Enter the Azure DevOps organization name, not a URL. Use 1–50 letters, numbers or internal hyphens. Re-enter your credentials to continue.",
    );
  }
  if (pat === "") throw new Error("A personal access token is required. Re-enter your credentials to continue.");
  if (requireWebhookSecret && secret === "") {
    throw new Error("A separate webhook secret is required. Re-enter your credentials to continue.");
  }
  return { "ado-org-name": orgName, "oauth-token": pat, ...(secret === "" ? {} : { secret }) };
}

/** Server error bodies may echo submitted values. Never render them for credential requests. */
export function azureDevOpsSaveError(error: unknown): string {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return "You are not authorized to save these credentials. Check your sign-in and VCS permissions, then re-enter your credentials.";
  }
  return "Could not save the Azure DevOps credentials. Check the organization and token, then re-enter your credentials and try again.";
}

export function AzureDevOpsCredentialFields({
  organization,
  onOrganizationChange,
  organizationReadOnly = false,
  requireWebhookSecret = true,
  patRef,
  webhookSecretRef,
}: CredentialRefs &
  Readonly<{
    organization: string;
    onOrganizationChange: (value: string) => void;
    organizationReadOnly?: boolean;
    requireWebhookSecret?: boolean;
  }>): React.JSX.Element {
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor="ado-organization" className="text-sm font-medium">
          Azure DevOps organization
        </label>
        <Input
          id="ado-organization"
          name="ado-org-name"
          autoComplete="off"
          spellCheck={false}
          value={organization}
          readOnly={organizationReadOnly}
          onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
            onOrganizationChange(event.currentTarget.value);
          }}
          placeholder="my-organization"
          aria-describedby="ado-organization-help"
          required
        />
        <p id="ado-organization-help" className="text-xs text-muted-foreground">
          The name after dev.azure.com/. Azure DevOps Server is not supported.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="ado-pat" className="text-sm font-medium">
          Personal access token (PAT)
        </label>
        <Input
          ref={patRef}
          id="ado-pat"
          name="ado-pat"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          aria-describedby="ado-pat-help"
          required
        />
        <p id="ado-pat-help" className="text-xs text-muted-foreground">
          Use an organization-scoped PAT with Code (Read) and Code (Status). Credentials are encrypted on the server and
          never displayed again. Saving a PAT does not verify live access.
        </p>
      </div>
      <div className="space-y-1.5">
        <label htmlFor="ado-webhook-secret" className="text-sm font-medium">
          {requireWebhookSecret ? "Webhook secret" : "Replacement webhook secret (optional)"}
        </label>
        <Input
          ref={webhookSecretRef}
          id="ado-webhook-secret"
          name="ado-webhook-secret"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          aria-describedby="ado-webhook-secret-help"
          required={requireWebhookSecret}
        />
        <p id="ado-webhook-secret-help" className="text-xs text-muted-foreground">
          Use a separate random secret of at least 32 characters for Azure service-hook Basic authentication. Keep it in
          your password manager. {requireWebhookSecret ? "" : "Leave blank to keep the current secret. "}
          Replacing it requires updating every existing service-hook subscription.
        </p>
      </div>
    </>
  );
}

export type AzureDevOpsClient = Readonly<{
  id: string;
  attributes: Readonly<{ name: string; "ado-org-name"?: string | null }>;
}>;

export function AzureDevOpsPatDialog({
  client,
  configured,
  onClose,
  onSaved,
}: Readonly<{
  client: AzureDevOpsClient;
  configured: boolean;
  onClose: (interrupted: boolean) => void;
  onSaved: () => void;
}>): React.JSX.Element {
  const [organization, setOrganization] = useState(client.attributes["ado-org-name"] ?? "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const patRef = useRef<HTMLInputElement>(null);
  const webhookSecretRef = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const credentialRefs = { patRef, webhookSecretRef };

  useEffect(
    (): (() => void) => (): void => {
      request.current?.abort();
    },
    [],
  );

  const close = (): void => {
    clearAzureDevOpsCredentials(credentialRefs);
    request.current?.abort();
    onClose(request.current !== null);
  };

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (request.current !== null) return;
    let attributes: ReturnType<typeof takeAzureDevOpsCredentials>;
    try {
      attributes = takeAzureDevOpsCredentials(organization, credentialRefs, false);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Check the organization and re-enter your credentials.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setSaving(true);
    setError("");
    try {
      await fetchApi(`/oauth-clients/${encodeURIComponent(client.id)}`, {
        method: "PATCH",
        signal: controller.signal,
        body: JSON.stringify({ data: { id: client.id, type: "oauth-clients", attributes } }),
      });
      if (!controller.signal.aborted) onSaved();
    } catch (caught: unknown) {
      if (!controller.signal.aborted) setError(azureDevOpsSaveError(caught));
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setSaving(false);
      }
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open): void => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{configured ? "Rotate PAT" : "Add PAT"}</DialogTitle>
          <DialogDescription>
            Update {client.attributes.name}. Existing workspace and policy-set connections keep their token ID when the
            organization is unchanged. An expired PAT must be replaced here.
          </DialogDescription>
        </DialogHeader>
        {error !== "" && (
          <div role="alert" className="rounded bg-destructive/15 p-3 text-xs text-destructive">
            {error}
          </div>
        )}
        <form
          noValidate
          onSubmit={(event): void => {
            void save(event);
          }}
          className="space-y-4"
        >
          <fieldset disabled={saving} className="space-y-4">
            <AzureDevOpsCredentialFields
              organization={organization}
              onOrganizationChange={setOrganization}
              organizationReadOnly={configured}
              requireWebhookSecret={false}
              {...credentialRefs}
            />
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner data-icon="inline-start" />}
              {saving ? "Saving PAT…" : "Save PAT"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AzureDevOpsHookDialog({
  client,
  onClose,
}: Readonly<{
  client: AzureDevOpsClient;
  onClose: () => void;
}>): React.JSX.Element {
  const endpoint = `${window.location.origin}/api/webhooks/azure-devops/${encodeURIComponent(client.id)}`;
  return (
    <Dialog
      open
      onOpenChange={(open): void => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Azure DevOps service hooks</DialogTitle>
          <DialogDescription>
            Configure service hooks for {client.attributes.name} in each Azure DevOps project you connect.
          </DialogDescription>
        </DialogHeader>
        <ol className="list-decimal space-y-3 pl-5 text-sm">
          <li>
            In Project settings → Service hooks, create Web Hooks subscriptions for Code pushed, Pull request created
            and Pull request updated. Select the repository connected to your workspace.
          </li>
          <li>
            Use this HTTPS URL, reachable from Azure DevOps. If this browser uses a private or HTTP address, use your
            public HTTPS Terrence address with the same path.
          </li>
        </ol>
        <div className="break-all rounded border bg-muted p-3 font-mono text-xs">{endpoint}</div>
        <p className="text-sm">
          Basic authentication username: <strong>{client.id}</strong>
        </p>
        <p className="text-sm">
          Basic authentication password: the separate webhook secret you supplied. Do not use your PAT. Existing secrets
          are never displayed.
        </p>
        <p className="text-sm text-muted-foreground">
          Use the full resource details in each event. Test the subscription in Azure DevOps, then push a commit or open
          a pull request to verify delivery and run status reporting. Saving credentials alone does not create
          subscriptions.
        </p>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
