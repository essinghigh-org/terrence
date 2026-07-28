import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
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
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi } from "@/lib/api";

type WorkspaceSettingsResource = {
  id: string;
  attributes: {
    name: string;
    "auto-apply"?: boolean;
    "auto-apply-run-trigger"?: boolean;
    "iac-binary"?: string;
    "terraform-version"?: string;
    permissions?: { "can-update"?: boolean };
    [key: string]: unknown;
  };
};

type IacBinary = "tofu" | "terraform";

export function WorkspaceSettings({
  workspace,
  onSaved,
}: Readonly<{
  workspace: WorkspaceSettingsResource;
  onSaved: (workspace: WorkspaceSettingsResource) => void;
}>): React.JSX.Element {
  const [iacBinary, setIacBinary] = useState<IacBinary>(
    workspace.attributes["iac-binary"] === "terraform" ? "terraform" : "tofu",
  );
  const [terraformVersion, setTerraformVersion] = useState(
    workspace.attributes["terraform-version"] ?? "latest",
  );
  const [autoApply, setAutoApply] = useState(workspace.attributes["auto-apply"] === true);
  const [autoApplyRunTrigger, setAutoApplyRunTrigger] = useState(
    workspace.attributes["auto-apply-run-trigger"] === true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const canUpdate = workspace.attributes.permissions?.["can-update"] !== false;

  const saveSettings = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const normalizedVersion = terraformVersion.trim() === "" ? "latest" : terraformVersion.trim();
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await fetchApi(`/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            attributes: {
              "iac-binary": iacBinary,
              "terraform-version": normalizedVersion,
              "auto-apply": autoApply,
              "auto-apply-run-trigger": autoApplyRunTrigger,
            },
          },
        }),
      }) as { data: WorkspaceSettingsResource };
      onSaved(response.data);
      setTerraformVersion(response.data.attributes["terraform-version"] ?? normalizedVersion);
      setSaved(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to save workspace settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={saveSettings} noValidate className="max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>General settings</CardTitle>
          <CardDescription>
            Configure the execution engine and automatic apply behavior for this remote workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-iac-binary">Execution engine</FieldLabel>
              <Select
                id="workspace-iac-binary"
                value={iacBinary}
                onValueChange={(value: string): void => { setIacBinary(value as IacBinary); }}
                disabled={!canUpdate}
              >
                <SelectItem value="tofu">OpenTofu</SelectItem>
                <SelectItem value="terraform">Terraform</SelectItem>
              </Select>
              <FieldDescription>
                Select the infrastructure-as-code binary used for plans and applies.
              </FieldDescription>
            </Field>
            <Field data-disabled={!canUpdate}>
              <FieldLabel htmlFor="workspace-terraform-version">Engine version</FieldLabel>
              <Input
                id="workspace-terraform-version"
                value={terraformVersion}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                  setTerraformVersion(event.target.value);
                }}
                onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                  setTerraformVersion(event.currentTarget.value);
                }}
                placeholder="latest or 1.9.3"
                disabled={!canUpdate}
              />
              <FieldDescription>
                Use latest, an exact version, or a supported version constraint.
              </FieldDescription>
            </Field>
            <FieldSet disabled={!canUpdate}>
              <FieldLegend variant="label">Automatic apply</FieldLegend>
              <FieldDescription>
                Successful plans require confirmation unless the applicable option is enabled.
              </FieldDescription>
              <FieldGroup className="gap-3">
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="workspace-auto-apply"
                    checked={autoApply}
                    onCheckedChange={(checked: boolean): void => { setAutoApply(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="workspace-auto-apply">Auto-apply API, UI, and VCS runs</FieldLabel>
                    <FieldDescription>Apply changes automatically after a successful plan.</FieldDescription>
                  </FieldContent>
                </Field>
                <Field orientation="horizontal" data-disabled={!canUpdate}>
                  <Checkbox
                    id="workspace-auto-apply-run-trigger"
                    checked={autoApplyRunTrigger}
                    onCheckedChange={(checked: boolean): void => { setAutoApplyRunTrigger(checked); }}
                    disabled={!canUpdate}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="workspace-auto-apply-run-trigger">Auto-apply run-triggered runs</FieldLabel>
                    <FieldDescription>
                      Apply runs created when an upstream workspace finishes.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>
            <FieldError>{error}</FieldError>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-between">
          <span role="status" className="text-sm text-muted-foreground">
            {saved ? "Settings saved." : canUpdate ? "" : "You do not have permission to update this workspace."}
          </span>
          <Button type="submit" disabled={saving || !canUpdate}>
            {saving && <Spinner data-icon="inline-start" />}
            {saving ? "Saving" : "Save settings"}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
