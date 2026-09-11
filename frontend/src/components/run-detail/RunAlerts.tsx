import { sectionLabel, type AuxKind } from "@/lib/run-view-state";
import { DegradedBanner } from "../DegradedBanner";

export function RunAlerts({ fresh, loadError, failedSections, onRetry }: Readonly<{
  fresh: boolean;
  loadError: string;
  failedSections: readonly AuxKind[];
  onRetry: () => void;
}>): React.JSX.Element | null {
  if (!fresh && loadError !== "") {
    return (
      <DegradedBanner
        title="Run data may be out of date. Actions are disabled until it refreshes."
        actionLabel="Try again"
        onAction={onRetry}
      />
    );
  }
  if (fresh && failedSections.length > 0) {
    return (
      <DegradedBanner
        // Naming the sections beats "some run details": the reader can tell
        // whether the part they came for is the stale one.
        title={`Could not refresh ${failedSections.map(sectionLabel).join(", ")}. The rest of this page is current.`}
        actionLabel="Try again"
        onAction={onRetry}
      />
    );
  }
  return null;
}
