import type { InsightTableRow } from "./InsightUI";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import {
  collectionDocument,
  records,
  text,
  useInsightAction,
  useInsightResource,
  type InsightRecord,
} from "../../lib/insights-api";
import { InsightError, InsightLoading, InsightNotice, InsightSection, InsightTable, JsonDetails } from "./InsightUI";
import { Runbooks } from "./RunInsightPanels";

function BlueprintForm({
  workspaceId,
  blueprintId,
  parameters,
}: Readonly<{ workspaceId: string; blueprintId: string; parameters: readonly InsightRecord[] }>): React.JSX.Element {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const action = useInsightAction(`${workspaceId}:${blueprintId}:${JSON.stringify(values)}`);
  const preview = (): void => {
    const parsed = Object.fromEntries(
      Object.entries(values).map(([name, value]): [string, string | readonly string[]] => [
        name,
        name.endsWith("-ids") ? value.split(/[\s,]+/).filter((id): boolean => id !== "") : value.trim(),
      ]),
    );
    void action.execute(`/workspace-blueprints/${encodeURIComponent(blueprintId)}/actions/preview`, {
      "workspace-id": workspaceId,
      parameters: parsed,
    });
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(event): void => {
        event.preventDefault();
        preview();
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        {parameters.map((parameter): React.JSX.Element => {
          const name = text(parameter["name"]);
          return (
            <label key={name} className="space-y-1 text-sm">
              {name}
              {parameter["required"] === true ? " (required)" : ""}
              <Input
                value={values[name] ?? ""}
                required={parameter["required"] === true}
                onInput={(event): void => {
                  setValues(
                    (current): Readonly<Record<string, string>> => ({ ...current, [name]: event.currentTarget.value }),
                  );
                }}
                disabled={action.busy}
              />
              <span className="block text-xs text-muted-foreground">{text(parameter["description"], "")}</span>
            </label>
          );
        })}
      </div>
      <Button type="submit" variant="outline" disabled={action.busy}>
        Preview blueprint configuration
      </Button>
      <InsightError error={action.error} />
      {action.result !== null && (
        <>
          <InsightNotice>
            {action.result.attributes["valid"] === true
              ? "Preview generated. No workspace, VCS link or attachment was created or changed."
              : "The preview contains validation errors. No configuration was changed."}
          </InsightNotice>
          <JsonDetails value={action.result.attributes} label="Blueprint preview and validation" />
        </>
      )}
    </form>
  );
}

function Blueprints({
  workspaceId,
  canUpdate,
}: Readonly<{ workspaceId: string; canUpdate: boolean }>): React.JSX.Element {
  const load = useInsightResource("/workspace-blueprints", collectionDocument);
  const [selection, setSelection] = useState("");
  const selected = load.data?.data.find((item): boolean => item.id === selection);
  return (
    <InsightSection
      title="Workspace blueprints"
      description="Reviewable starting points, not a second provisioning system. Preview never mutates a workspace."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <label className="block space-y-1 text-sm">
          Blueprint
          <Select value={selected?.id ?? ""} onValueChange={setSelection}>
            <option value="">Choose a blueprint</option>
            {load.data.data.map(
              (item): React.JSX.Element => (
                <option key={item.id} value={item.id}>
                  {text(item.attributes["name"])}
                </option>
              ),
            )}
          </Select>
        </label>
      )}
      {selected !== undefined && (
        <>
          <p className="text-sm text-muted-foreground">{text(selected.attributes["description"])}</p>
          {canUpdate ? (
            <BlueprintForm
              key={selected.id}
              workspaceId={workspaceId}
              blueprintId={selected.id}
              parameters={records(selected.attributes["parameters"])}
            />
          ) : (
            <InsightNotice>
              Workspace administrator permission is required to preview configuration against this workspace.
            </InsightNotice>
          )}
        </>
      )}
    </InsightSection>
  );
}

function PolicyPacks(): React.JSX.Element {
  const load = useInsightResource("/policy-packs", collectionDocument);
  return (
    <InsightSection
      title="Policy pack reference"
      description="Advisory rule descriptions and blind spots. These are not evaluated policy outcomes and do not authorize apply."
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data?.data.map(
        (pack): React.JSX.Element => (
          <div key={pack.id} className="space-y-2 rounded-md border border-border p-4">
            <h3 className="font-semibold">{text(pack.attributes["name"])}</h3>
            <p className="text-sm text-muted-foreground">{text(pack.attributes["description"])}</p>
            <InsightTable
              headings={["Rule", "Intent", "Limitations"]}
              rows={records(pack.attributes["rules"]).map(
                (rule): InsightTableRow => ({
                  id: text(rule["id"]),
                  cells: [text(rule["title"]), text(rule["logic"]), text(rule["blindSpot"] ?? rule["blind-spot"])],
                }),
              )}
              empty="No rule descriptions returned."
            />
          </div>
        ),
      )}
    </InsightSection>
  );
}

export function ReferenceCatalog({
  workspaceId,
  canUpdate,
}: Readonly<{ workspaceId: string; canUpdate: boolean }>): React.JSX.Element {
  return (
    <div className="space-y-6">
      <Blueprints workspaceId={workspaceId} canUpdate={canUpdate} />
      <PolicyPacks />
      <Runbooks />
    </div>
  );
}
