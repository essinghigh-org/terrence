import type { InsightTableRow } from "../insights/InsightUI";
import { useState } from "react";
import { Button } from "../ui/button";
import { ConfirmDialog } from "../ui/confirm-dialog";
import {
  collectionDocument,
  numberValue,
  resourceDocument,
  text,
  useInsightAction,
  useInsightResource,
} from "../../lib/insights-api";
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

function DeliveryDetail({ id }: Readonly<{ id: string }>): React.JSX.Element {
  const load = useInsightResource(`/admin/webhook-deliveries/${encodeURIComponent(id)}`, resourceDocument);
  return (
    <InsightSection title="Delivery evidence" description={id}>
      <InsightError error={load.error} retry={load.reload} />
      {load.loading && <InsightLoading />}
      {load.data !== null && <JsonDetails value={load.data.attributes} label="Inspect redacted delivery" />}
    </InsightSection>
  );
}

export function OperationsWebhooks(): React.JSX.Element {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const [retryId, setRetryId] = useState<string | null>(null);
  const load = useInsightResource(`/admin/webhook-deliveries?page[number]=${page}&page[size]=20`, collectionDocument);
  const action = useInsightAction("webhook-retry");
  const retry = async (): Promise<void> => {
    if (retryId === null) return;
    const result = await action.execute(`/admin/webhook-deliveries/${encodeURIComponent(retryId)}/actions/retry`);
    if (result !== null) {
      setRetryId(null);
      load.reload();
    }
  };
  return (
    <div className="space-y-6">
      <InsightSection
        title="VCS webhook deliveries"
        description="Inspect received events and retry failed deliveries using their original idempotent identity."
      >
        <InsightNotice>
          Retry and replay are the same backend operation. Successful deliveries cannot be replayed, and retrying does
          not intentionally create a new logical event.
        </InsightNotice>
        <InsightError error={load.error} retry={load.reload} />
        <InsightError error={action.error} />
        {load.loading && <InsightLoading />}
        <Button size="sm" variant="outline" disabled={load.loading || action.busy} onClick={load.reload}>
          Refresh deliveries
        </Button>
        {load.data !== null && (
          <>
            <InsightTable
              headings={["Repository / event", "Provider", "Status", "Attempts", "Updated", "Actions"]}
              empty="No VCS webhook deliveries recorded."
              rows={load.data.data.map(
                (delivery): InsightTableRow => ({
                  id: delivery.id,
                  cells: [
                    <div key="event">
                      <p>{text(delivery.attributes["repository"], "Repository not recorded")}</p>
                      <p className="text-xs text-muted-foreground">{text(delivery.attributes["event-name"])}</p>
                    </div>,
                    text(delivery.attributes["provider"]),
                    <InsightStatus key="status" value={delivery.attributes["status"]} />,
                    String(numberValue(delivery.attributes["attempts"]) ?? "?"),
                    <InsightDate key="date" value={delivery.attributes["updated-at"]} />,
                    <div key="actions" className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(): void => {
                          setSelected(delivery.id);
                        }}
                      >
                        Inspect
                      </Button>
                      {["failed", "errored", "dead_letter"].includes(text(delivery.attributes["status"])) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={action.busy}
                          onClick={(): void => {
                            setRetryId(delivery.id);
                          }}
                        >
                          Retry
                        </Button>
                      )}
                    </div>,
                  ],
                }),
              )}
            />
            <InsightPagination collection={load.data} page={page} setPage={setPage} busy={action.busy} />
          </>
        )}
        {action.result !== null && (
          <p role="status" className="text-sm">
            Delivery retry accepted. Refresh the delivery for its processing result.
          </p>
        )}
        <ConfirmDialog
          open={retryId !== null}
          onOpenChange={(open): void => {
            if (!open && !action.busy) setRetryId(null);
          }}
          title="Retry failed delivery?"
          description={`Delivery ${retryId ?? ""} will be reprocessed. Any resulting runs remain subject to normal workspace controls.`}
          confirmText="Retry delivery"
          confirmVariant="default"
          loading={action.busy}
          onConfirm={retry}
        />
      </InsightSection>
      {selected !== "" && <DeliveryDetail key={selected} id={selected} />}
    </div>
  );
}
