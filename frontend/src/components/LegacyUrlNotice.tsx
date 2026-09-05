import { useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";

const STORAGE_KEY = "terrence:legacy-url-redirect";

/**
 * Records that the user arrived via a Terraform CLI legacy URL alias
 * (`/app/<org>/<workspace>/...`, no `/workspaces/` segment) so the landing
 * page can show a one-time subtle notice (issue #641). Best effort: when
 * storage is unavailable the redirect still works, just without the notice.
 */
export function markLegacyUrlRedirect(legacyPath: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, legacyPath);
  } catch {
    // Storage unavailable (private mode, disabled cookies): skip the notice.
  }
}

/**
 * One-time subtle notice shown after a legacy-URL redirect. Reads and clears
 * the flag on mount, so it appears once and never on canonical navigation.
 */
export function LegacyUrlNotice(): React.JSX.Element | null {
  const [legacyPath, setLegacyPath] = useState<string | null>((): string | null => {
    try {
      const value = sessionStorage.getItem(STORAGE_KEY);
      sessionStorage.removeItem(STORAGE_KEY);
      return value;
    } catch {
      return null;
    }
  });
  if (legacyPath === null) return null;
  return (
    <p role="status" className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <span>
        You followed a Terraform CLI link ({legacyPath}); it now lives under the /workspaces/ path. This is the same page.
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss redirect notice"
        onClick={(): void => { setLegacyPath(null); }}
      >
        <X className="size-3.5" aria-hidden="true" />
      </Button>
    </p>
  );
}
