import type { InsightTableRow } from "./InsightUI";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { copyTextToClipboard } from "../../lib/utils";
import { record, records, resourceDocument, text, useInsightAction, useInsightResource } from "../../lib/insights-api";
import {
  InsightError,
  InsightLoading,
  InsightNotice,
  InsightSection,
  InsightStatus,
  InsightTable,
  JsonDetails,
} from "./InsightUI";

type ImportRow = Readonly<{ id: string; address: string; providerId: string }>;

function ImportReview({ workspaceId, engine }: Readonly<{ workspaceId: string; engine: string }>): React.JSX.Element {
  const [mappings, setMappings] = useState<readonly ImportRow[]>([{ id: "first", address: "", providerId: "" }]);
  const [copyStatus, setCopyStatus] = useState("");
  const action = useInsightAction(`${workspaceId}:${JSON.stringify(mappings)}`);
  const valid =
    mappings.length > 0 &&
    mappings.every((item): boolean => item.address.trim() !== "" && item.providerId.trim() !== "");
  const update = (id: string, field: "address" | "providerId", value: string): void => {
    setMappings((items): readonly ImportRow[] =>
      items.map((item): ImportRow => (item.id === id ? { ...item, [field]: value } : item)),
    );
  };
  const raw = action.result?.attributes["generated-configuration"];
  const generated = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string").join("\n\n")
    : "";
  const conflicts = action.result?.attributes["conflicts"];
  return (
    <InsightSection
      title="Import workbench"
      description="Generate import blocks from explicit resource mappings. The workbench does not query cloud providers, discover required resource arguments, or apply imports."
    >
      <form
        className="space-y-3"
        onSubmit={(event): void => {
          event.preventDefault();
          if (valid) {
            setCopyStatus("");
            void action.execute(`/workspaces/${encodeURIComponent(workspaceId)}/import-workbench`, {
              engine,
              mappings: mappings.map(
                (item): Readonly<Record<string, string>> => ({
                  address: item.address.trim(),
                  "provider-id": item.providerId.trim(),
                }),
              ),
            });
          }
        }}
      >
        {mappings.map(
          (item, index): React.JSX.Element => (
            <div key={item.id} className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
              <label className="space-y-1 text-sm">
                Resource address {index + 1}
                <Input
                  value={item.address}
                  onInput={(event): void => {
                    update(item.id, "address", event.currentTarget.value);
                  }}
                  placeholder="aws_instance.example"
                  disabled={action.busy}
                  required
                />
              </label>
              <label className="space-y-1 text-sm">
                Provider ID {index + 1}
                <Input
                  value={item.providerId}
                  onInput={(event): void => {
                    update(item.id, "providerId", event.currentTarget.value);
                  }}
                  placeholder="i-0123456789"
                  disabled={action.busy}
                  required
                />
              </label>
              <Button
                className="self-end"
                variant="outline"
                type="button"
                aria-label={`Remove mapping ${index + 1}`}
                disabled={action.busy || mappings.length === 1}
                onClick={(): void => {
                  setMappings((items): readonly ImportRow[] => items.filter((row): boolean => row.id !== item.id));
                }}
              >
                Remove
              </Button>
            </div>
          ),
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={action.busy || mappings.length >= 50}
            onClick={(): void => {
              setMappings((items): readonly ImportRow[] => [
                ...items,
                { id: crypto.randomUUID(), address: "", providerId: "" },
              ]);
            }}
          >
            Add mapping
          </Button>
          <Button type="submit" disabled={action.busy || !valid}>
            Generate import review
          </Button>
        </div>
      </form>
      <InsightError error={action.error} />
      {action.result !== null && (
        <>
          <InsightStatus value={action.result.attributes["status"]} />
          {Array.isArray(conflicts) && conflicts.length > 0 && (
            <InsightNotice>
              Some provider IDs already appear in retained state. Review the conflict evidence before using this
              configuration.
            </InsightNotice>
          )}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-xs">{generated}</pre>
          <Button
            variant="outline"
            size="sm"
            disabled={generated === ""}
            onClick={(): void => {
              void copyTextToClipboard(generated).then((copied): void => {
                setCopyStatus(copied ? "Import blocks copied." : "Copy failed.");
              });
            }}
          >
            Copy import blocks
          </Button>
          <p role="status" className="text-sm">
            {copyStatus}
          </p>
          <JsonDetails value={action.result.attributes} label="Import review evidence" />
        </>
      )}
    </InsightSection>
  );
}

function UpgradeReview({
  workspaceId,
  engine,
  workspacePath,
}: Readonly<{ workspaceId: string; engine: string; workspacePath: string }>): React.JSX.Element {
  const [candidate, setCandidate] = useState(engine);
  const [version, setVersion] = useState("");
  const [digest, setDigest] = useState("");
  const action = useInsightAction(`${workspaceId}:${candidate}:${version}:${digest}`);
  const result = record(action.result?.attributes["result"]);
  const diagnostics = result["diagnostics"];
  return (
    <InsightSection
      title="Engine upgrade review"
      description="Record candidate metadata against retained state. This endpoint does not execute a CLI, install an engine or run a speculative plan."
    >
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(event): void => {
          event.preventDefault();
          if (version.trim() !== "")
            void action.execute(`/workspaces/${encodeURIComponent(workspaceId)}/upgrade-rehearsals`, {
              engine: candidate,
              version: version.trim(),
              ...(digest.trim() === "" ? {} : { "candidate-lock-digest": digest.trim() }),
            });
        }}
      >
        <label className="space-y-1 text-sm">
          Candidate engine
          <Select value={candidate} onValueChange={setCandidate} disabled={action.busy}>
            <option value="terraform">Terraform</option>
            <option value="tofu">OpenTofu</option>
          </Select>
        </label>
        <label className="space-y-1 text-sm">
          Candidate version
          <Input
            value={version}
            onInput={(event): void => {
              setVersion(event.currentTarget.value);
            }}
            placeholder="1.10.0"
            required
            disabled={action.busy}
          />
        </label>
        <label className="space-y-1 text-sm md:col-span-2">
          Candidate lock-file SHA-256 (optional)
          <Input
            value={digest}
            onInput={(event): void => {
              setDigest(event.currentTarget.value);
            }}
            pattern="[a-f0-9]{64}"
            disabled={action.busy}
          />
        </label>
        <Button type="submit" disabled={action.busy || version.trim() === ""}>
          Create upgrade review
        </Button>
      </form>
      <InsightError error={action.error} />
      {action.result !== null && (
        <>
          <InsightNotice>
            {result["status"] === "invalid"
              ? "Candidate metadata is invalid. No execution has taken place."
              : "Candidate metadata recorded. This is not a passed plan or a compatibility guarantee; run a separately reviewed speculative plan."}
          </InsightNotice>
          {result["baseline-fresh"] === false && (
            <InsightNotice>The retained baseline is older than the backend freshness window.</InsightNotice>
          )}
          {Array.isArray(diagnostics) &&
            diagnostics.map(
              (item, index): React.JSX.Element => (
                <p key={index} className="text-sm text-destructive">
                  {text(item)}
                </p>
              ),
            )}
          <JsonDetails value={action.result.attributes} label="Upgrade review evidence" />
        </>
      )}
      <Link className="text-sm text-primary hover:underline" to={`${workspacePath}/runs?new-run=true`}>
        Open the normal run workflow
      </Link>
    </InsightSection>
  );
}

function DependencyReview({ workspaceId }: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const [target, setTarget] = useState("");
  const action = useInsightAction(`${workspaceId}:${target}`);
  return (
    <InsightSection
      title="Declared dependency preview"
      description="Review explicit downstream workspace IDs. This is not automatic dependency discovery and does not queue downstream plans."
    >
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event): void => {
          event.preventDefault();
          const ids = [...new Set(target.split(/[\s,]+/).filter((value): boolean => value !== ""))].slice(0, 50);
          if (ids.length > 0)
            void action.execute(`/workspaces/${encodeURIComponent(workspaceId)}/dependency-impact-previews`, {
              edges: ids.map(
                (id): Readonly<Record<string, string>> => ({ from: workspaceId, to: id, source: "explicit" }),
              ),
              "max-fanout": 50,
            });
        }}
      >
        <label className="min-w-64 flex-1 space-y-1 text-sm">
          Downstream workspace IDs
          <Input
            value={target}
            onInput={(event): void => {
              setTarget(event.currentTarget.value);
            }}
            placeholder="ws-example, ws-another"
            disabled={action.busy}
            required
          />
        </label>
        <Button type="submit" disabled={action.busy || target.trim() === ""}>
          Preview declared impact
        </Button>
      </form>
      <InsightError error={action.error} />
      {action.result !== null && (
        <>
          <InsightNotice>
            Only authorized same-organization targets are returned. Omitted targets are not evidence of no dependency.
            Previewing does not execute anything.
          </InsightNotice>
          <InsightTable
            headings={["From", "To", "Evidence source"]}
            rows={records(action.result.attributes["edges"]).map(
              (edge, index): InsightTableRow => ({
                id: String(index),
                cells: [text(edge["from"]), text(edge["to"]), text(edge["source"])],
              }),
            )}
            empty="No authorized declared edges in this preview."
          />
          <JsonDetails value={action.result.attributes} label="Dependency preview, limits and cycles" />
        </>
      )}
    </InsightSection>
  );
}

function AdoptionExport({ workspaceId }: Readonly<{ workspaceId: string }>): React.JSX.Element {
  const [requested, setRequested] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const load = useInsightResource(
    requested ? `/workspaces/${encodeURIComponent(workspaceId)}/adoption-export` : null,
    resourceDocument,
  );
  const content = text(load.data?.attributes["content"], "");
  return (
    <InsightSection
      title="Manage this workspace as code"
      description="Export reviewed HCL for adopting workspace configuration. Credentials, sensitive values and unsupported fields require explicit operator input."
    >
      <Button
        variant="outline"
        onClick={(): void => {
          setRequested(true);
          if (requested) load.reload();
        }}
        disabled={load.loading}
      >
        Generate adoption HCL
      </Button>
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-4 text-xs">{content}</pre>
          <Button
            variant="outline"
            disabled={content === ""}
            onClick={(): void => {
              void copyTextToClipboard(content).then((copied): void => {
                setCopyStatus(copied ? "Adoption HCL copied." : "Copy failed.");
              });
            }}
          >
            Copy adoption HCL
          </Button>
          <p role="status" className="text-sm">
            {copyStatus}
          </p>
        </>
      )}
    </InsightSection>
  );
}

export function ReviewTools({
  workspaceId,
  workspacePath,
  engine,
  canPlan,
}: Readonly<{ workspaceId: string; workspacePath: string; engine: string; canPlan: boolean }>): React.JSX.Element {
  return (
    <div className="space-y-6">
      {canPlan ? (
        <>
          <ImportReview workspaceId={workspaceId} engine={engine} />
          <UpgradeReview workspaceId={workspaceId} workspacePath={workspacePath} engine={engine} />
        </>
      ) : (
        <InsightNotice>Import and upgrade reviews require plan permission.</InsightNotice>
      )}
      <DependencyReview workspaceId={workspaceId} />
      <AdoptionExport workspaceId={workspaceId} />
    </div>
  );
}
