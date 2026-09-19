import type { InsightTableRow } from "../insights/InsightUI";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ConfirmDialog } from "../ui/confirm-dialog";
import {
  record,
  records,
  resourceDocument,
  text,
  numberValue,
  useInsightAction,
  useInsightResource,
  type InsightRecord,
} from "../../lib/insights-api";
import {
  InsightDate,
  InsightError,
  InsightLoading,
  InsightNotice,
  InsightSection,
  InsightStatus,
  InsightTable,
  JsonDetails,
} from "../insights/InsightUI";

type BackupAction = "manifests" | "integrity-checks" | "restore-rehearsals";
const LABELS: Readonly<Record<BackupAction, string>> = {
  manifests: "Create manifest",
  "integrity-checks": "Verify integrity",
  "restore-rehearsals": "Rehearse restore",
};

function BackupFreshness(): React.JSX.Element {
  const load = useInsightResource("/admin/operations-center", resourceDocument);
  const action = useInsightAction("backup-freshness");
  const [days, setDays] = useState<string | null>(null);
  const backup = record(load.data?.attributes["backup"]);
  const configured = numberValue(load.data?.attributes["rehearsal-max-age-days"]);
  const input = days ?? (configured === null ? "" : String(configured));
  const valid = Number.isInteger(Number(input)) && Number(input) >= 1 && Number(input) <= 3650;
  return (
    <InsightSection
      title="Restore confidence"
      description="A verified rehearsal is evidence of recoverability, not a backup schedule or an RPO guarantee."
    >
      <InsightError error={load.error} retry={load.reload} />
      <InsightError error={action.error} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <InsightStatus value={backup["status"]} />
            <span>
              Last verified restore: <InsightDate value={backup["last-verified-restore-at"]} />
            </span>
          </div>
          {backup["status"] === "unknown" && (
            <InsightNotice>
              No successful restore rehearsal is recorded. A newly created manifest does not count as a verified
              restore.
            </InsightNotice>
          )}
          {backup["status"] === "overdue" && (
            <InsightNotice>
              The last successful rehearsal is older than the configured threshold. Rehearse a recent backup before
              relying on it.
            </InsightNotice>
          )}
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event): void => {
              event.preventDefault();
              if (!valid) return;
              void action
                .execute("/admin/operations-center/settings", { "rehearsal-max-age-days": Number(input) }, "PATCH")
                .then((result): void => {
                  if (result !== null) {
                    setDays(null);
                    load.reload();
                  }
                });
            }}
          >
            <label className="space-y-1 text-sm">
              Warn after (days)
              <Input
                type="number"
                min={1}
                max={3650}
                value={input}
                onInput={(event): void => {
                  setDays(event.currentTarget.value);
                }}
                required
              />
            </label>
            <Button type="submit" variant="outline" disabled={action.busy || !valid}>
              Save rehearsal threshold
            </Button>
          </form>
          {action.result !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              Rehearsal threshold saved.
            </p>
          )}
        </>
      )}
    </InsightSection>
  );
}

function BackupReport({ attributes }: Readonly<{ attributes: InsightRecord }>): React.JSX.Element {
  const report = record(attributes["result"]);
  const checks = records(attributes["checks"] ?? report["checks"]);
  const passed = attributes["passed"] ?? report["passed"];
  const failure = record(attributes["error"]);
  return (
    <div className="space-y-3" aria-live="polite">
      <p className="flex items-center gap-2 text-sm">
        Verification{" "}
        <InsightStatus
          value={passed === true ? "pass" : passed === false ? "failed" : (attributes["status"] ?? "evidence recorded")}
        />
      </p>
      {typeof failure["detail"] === "string" && <InsightError error={failure["detail"]} />}
      <InsightTable
        headings={["Check", "Result", "Details"]}
        empty="No verification checks in this response."
        rows={checks.map(
          (check, index): InsightTableRow => ({
            id: `${text(check["code"], "check")}-${index}`,
            cells: [
              text(check["code"] ?? check["name"]),
              <InsightStatus key="status" value={check["status"]} />,
              text(check["detail"] ?? check["message"], "—"),
            ],
          }),
        )}
      />
      <JsonDetails value={attributes} label="View verification evidence" />
    </div>
  );
}

function RehearsalProgress({ id, onFinished }: Readonly<{ id: string; onFinished: () => void }>): React.JSX.Element {
  const load = useInsightResource(`/admin/backups/restore-rehearsals/${encodeURIComponent(id)}`, resourceDocument);
  const status = load.data?.attributes["status"];
  useEffect((): (() => void) | undefined => {
    if (status !== "running") return undefined;
    const timer = setTimeout(load.reload, 2000);
    return (): void => {
      clearTimeout(timer);
    };
  }, [status, load.checkedAt, load.reload]);
  useEffect((): void => {
    if (status === "done" || status === "failed") onFinished();
  }, [status, onFinished]);
  return (
    <InsightSection
      title="Restore rehearsal"
      description={`Rehearsal ${id}. The live database and volume are never replaced.`}
    >
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {status === "running" && (
        <p role="status" className="text-sm">
          The disposable restore is running. This page will refresh its result.
        </p>
      )}
      {load.data !== null && <BackupReport attributes={load.data.attributes} />}
      <InsightNotice>
        Rehearsal jobs are retained in process memory. After a service restart a missing job is unknown, not successful;
        the last verified timestamp remains the durable evidence.
      </InsightNotice>
    </InsightSection>
  );
}

function BackupTools({ onFinished }: Readonly<{ onFinished: () => void }>): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const [path, setPath] = useState("");
  const [databasePath, setDatabasePath] = useState("");
  const [storagePath, setStoragePath] = useState("");
  const [confirmation, setConfirmation] = useState<Readonly<{ kind: BackupAction; attributes: InsightRecord }> | null>(
    null,
  );
  const action = useInsightAction("backup-tools");
  const rehearsal = params.get("rehearsal") ?? "";
  const prepare = (kind: BackupAction): void => {
    if (path.trim() === "" || action.busy) return;
    setConfirmation({
      kind,
      attributes: {
        "backup-path": path.trim(),
        ...(databasePath.trim() === "" ? {} : { "database-path": databasePath.trim() }),
        ...(storagePath.trim() === "" ? {} : { "storage-path": storagePath.trim() }),
      },
    });
  };
  const confirm = async (): Promise<void> => {
    if (confirmation === null) return;
    const result = await action.execute(`/admin/backups/${confirmation.kind}`, confirmation.attributes);
    if (result !== null) {
      if (confirmation.kind === "restore-rehearsals")
        setParams((current): URLSearchParams => {
          const next = new URLSearchParams(current);
          next.set("rehearsal", result.id);
          return next;
        });
      setConfirmation(null);
    }
  };
  return (
    <>
      <InsightSection
        title="Verify an operator backup"
        description="Paths refer to files on the Terrence host, not your browser. Use a stopped, consistent SQLite backup copy; PostgreSQL recovery remains an operator-managed workflow."
      >
        <InsightNotice>
          These actions create evidence and test a disposable copy. They do not create a backup, restore production,
          decrypt files for download, or change the live execution state.
        </InsightNotice>
        <label className="block space-y-1 text-sm">
          Backup path
          <Input
            value={path}
            onInput={(event): void => {
              setPath(event.currentTarget.value);
            }}
            placeholder="/var/backups/terrence/2026-09-19"
            disabled={action.busy}
          />
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Advanced source paths</summary>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label>
              Database path (optional)
              <Input
                value={databasePath}
                onInput={(event): void => {
                  setDatabasePath(event.currentTarget.value);
                }}
                disabled={action.busy}
              />
            </label>
            <label>
              Storage path (optional)
              <Input
                value={storagePath}
                onInput={(event): void => {
                  setStoragePath(event.currentTarget.value);
                }}
                disabled={action.busy}
              />
            </label>
          </div>
        </details>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(LABELS) as BackupAction[]).map(
            (kind): React.JSX.Element => (
              <Button
                key={kind}
                variant="outline"
                disabled={action.busy || path.trim() === ""}
                onClick={(): void => {
                  prepare(kind);
                }}
              >
                {LABELS[kind]}
              </Button>
            ),
          )}
        </div>
        <InsightError error={action.error} />
        {action.result !== null && action.result.type !== "backup-restore-rehearsals" && (
          <BackupReport attributes={action.result.attributes} />
        )}
        <ConfirmDialog
          open={confirmation !== null}
          onOpenChange={(open): void => {
            if (!open && !action.busy) setConfirmation(null);
          }}
          title={confirmation === null ? "Confirm backup operation" : LABELS[confirmation.kind]}
          description={
            <>
              <span className="block">
                Source: <code className="break-all">{text(confirmation?.attributes["backup-path"])}</code>
              </span>
              <span className="mt-2 block">
                This may read and hash the entire backup. A rehearsal extracts into a private temporary directory. No
                live restore is performed.
              </span>
            </>
          }
          confirmText="Continue"
          confirmVariant="default"
          requireCheckbox="This is an operator-created, consistent backup copy, not the active database or storage directory."
          loading={action.busy}
          onConfirm={confirm}
        />
      </InsightSection>
      {rehearsal !== "" && <RehearsalProgress key={rehearsal} id={rehearsal} onFinished={onFinished} />}
    </>
  );
}

export function OperationsBackups(): React.JSX.Element {
  const [revision, setRevision] = useState(0);
  const refreshed = useCallback((): void => {
    setRevision((value): number => value + 1);
  }, []);
  return (
    <div className="space-y-6">
      <BackupFreshness key={revision} />
      <BackupTools onFinished={refreshed} />
    </div>
  );
}
