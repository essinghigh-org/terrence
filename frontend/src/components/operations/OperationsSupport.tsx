import type { InsightTableRow } from "../insights/InsightUI";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import { collectionDocument, downloadInsight, useInsightAction, useInsightResource } from "../../lib/insights-api";
import {
  InsightDate,
  InsightError,
  InsightLoading,
  InsightNotice,
  InsightPagination,
  InsightSection,
  InsightStatus,
  InsightTable,
  JsonDetails,
} from "../insights/InsightUI";

export function OperationsSupport(): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [confirmation, setConfirmation] = useState<Readonly<{ kind: "create" | "delete"; id: string }> | null>(null);
  const [downloadError, setDownloadError] = useState("");
  const [downloading, setDownloading] = useState("");
  const load = useInsightResource(`/admin/support-bundles?page[number]=${page}&page[size]=20`, collectionDocument);
  const action = useInsightAction("support-bundles");
  const generating = load.data?.data.some((bundle): boolean => bundle.attributes["status"] === "generating") === true;
  useEffect((): (() => void) | undefined => {
    if (!generating) return undefined;
    const timer = setTimeout(load.reload, 2500);
    return (): void => {
      clearTimeout(timer);
    };
  }, [generating, load.checkedAt, load.reload]);
  const confirm = async (): Promise<void> => {
    if (confirmation === null) return;
    const result =
      confirmation.kind === "create"
        ? await action.execute("/admin/support-bundles")
        : await action.execute(`/admin/support-bundles/${encodeURIComponent(confirmation.id)}`, {}, "DELETE");
    if (result !== null) {
      setConfirmation(null);
      load.reload();
    }
  };
  const download = async (id: string): Promise<void> => {
    setDownloadError("");
    setDownloading(id);
    try {
      await downloadInsight(
        `/admin/support-bundles/${encodeURIComponent(id)}/download`,
        `terrence-support-${id}.tar.gz`,
      );
    } catch (error: unknown) {
      setDownloadError(error instanceof Error ? error.message : "Download failed");
    } finally {
      setDownloading("");
    }
  };
  return (
    <InsightSection
      title="Support bundles"
      description="Generate bounded, redacted diagnostics for the local control-plane node. Browser requests use your site-admin session, not a System API token."
    >
      <InsightNotice>
        Bundles exclude database dumps, state, raw plans, configuration archives, secret values, bearer tokens and
        signed URLs. Review the manifest before sharing. Bundles expire automatically.
      </InsightNotice>
      <div className="flex gap-2">
        <Button
          disabled={action.busy || generating || load.loading}
          onClick={(): void => {
            setConfirmation({ kind: "create", id: "" });
          }}
        >
          Generate local bundle
        </Button>
        <Button variant="outline" disabled={load.loading || action.busy} onClick={load.reload}>
          Refresh bundles
        </Button>
      </div>
      <InsightError error={load.error} retry={load.reload} />
      <InsightError error={action.error} />
      <InsightError error={downloadError} />
      {load.loading && <InsightLoading />}
      {load.data !== null && (
        <>
          <InsightTable
            headings={["Bundle", "Status", "Created", "Expires", "Actions"]}
            empty="No retained support bundles."
            rows={load.data.data.map(
              (bundle): InsightTableRow => ({
                id: bundle.id,
                cells: [
                  <div key="bundle">
                    <code className="text-xs">{bundle.id}</code>
                    <JsonDetails value={bundle.attributes["manifest"]} label="Manifest" />
                  </div>,
                  <InsightStatus key="status" value={bundle.attributes["status"]} />,
                  <InsightDate key="created" value={bundle.attributes["created_at"]} />,
                  <InsightDate key="expires" value={bundle.attributes["expires_at"]} />,
                  <div key="actions" className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={bundle.attributes["status"] !== "finished" || downloading !== ""}
                      onClick={(): void => {
                        void download(bundle.id);
                      }}
                    >
                      {downloading === bundle.id ? "Downloading…" : "Download"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={action.busy}
                      onClick={(): void => {
                        setConfirmation({ kind: "delete", id: bundle.id });
                      }}
                    >
                      {bundle.attributes["status"] === "generating" ? "Cancel" : "Delete"}
                    </Button>
                  </div>,
                ],
              }),
            )}
          />
          <InsightPagination collection={load.data} page={page} setPage={setPage} busy={action.busy} />
        </>
      )}
      <ConfirmDialog
        open={confirmation !== null}
        onOpenChange={(open): void => {
          if (!open && !action.busy) setConfirmation(null);
        }}
        title={confirmation?.kind === "delete" ? "Delete support bundle?" : "Generate local support bundle?"}
        description={
          confirmation?.kind === "delete"
            ? `Bundle ${confirmation.id} will be canceled or its artifact deleted. This does not delete application data.`
            : "The local node will collect allowlisted diagnostics and generate a temporary archive. No remote node credentials are forwarded."
        }
        confirmText={confirmation?.kind === "delete" ? "Delete bundle" : "Generate bundle"}
        confirmVariant={confirmation?.kind === "delete" ? "destructive" : "default"}
        loading={action.busy}
        onConfirm={confirm}
      />
    </InsightSection>
  );
}
