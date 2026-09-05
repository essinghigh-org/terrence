import { useId } from "react";
import { AlertTriangle, ChevronRight, XCircle } from "lucide-react";
import type { TerraformDiagnostic, TerraformDiagnosticSeverity } from "../lib/diagnostics";

const SEVERITY_STYLES = {
  warning: {
    section: "border-warning/30 bg-warning/10",
    text: "text-warning",
    icon: AlertTriangle,
    label: "Warnings",
  },
  error: {
    section: "border-destructive/30 bg-destructive/10",
    text: "text-destructive",
    icon: XCircle,
    label: "Diagnostics",
  },
} satisfies Record<TerraformDiagnosticSeverity, Readonly<{
  section: string;
  text: string;
  icon: typeof AlertTriangle;
  label: string;
}>>;

/**
 * Inline diagnostic bubble for a run phase. Warnings render amber and do
 * not affect the run status; errors use the destructive palette. Renders
 * nothing when the list is empty.
 */
export function DiagnosticsBanner(props: Readonly<{
  severity: TerraformDiagnosticSeverity;
  diagnostics: readonly TerraformDiagnostic[];
  collapsible?: boolean;
  defaultOpen?: boolean;
}>): React.JSX.Element | null {
  const { severity, diagnostics, collapsible = false, defaultOpen = true } = props;
  const headingId = useId();
  if (diagnostics.length === 0) return null;
  const styles = SEVERITY_STYLES[severity];
  const Icon = styles.icon;

  if (collapsible) {
    return (
      <details className="border-t border-border group/diagnostics" open={defaultOpen ? true : undefined}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-sm font-medium text-foreground/85 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 text-muted-foreground group-open/diagnostics:rotate-90" aria-hidden="true" />
          <div className="flex items-center gap-2">
            <Icon className={`size-4 ${styles.text}`} aria-hidden="true" />
            <span>
              {styles.label}{" "}
              <span className="font-normal text-muted-foreground">({diagnostics.length})</span>
            </span>
          </div>
        </summary>
        <div className="border-t border-border px-4 py-2">
          <ul className="space-y-2">
            {diagnostics.map((diagnostic, index): React.JSX.Element => (
              <li
                key={`${diagnostic.severity}-${diagnostic.title}-${index}`}
                className={`min-w-0 rounded-sm border px-3 py-2 ${styles.section}`}
              >
                <p className={`break-words text-sm font-medium ${styles.text}`}>{diagnostic.title}</p>
                {diagnostic.body !== "" && (
                  <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-4 text-foreground/85">
                    {diagnostic.body.trim().replace(/\n(?:[ \t]*\n)+/g, "\n")}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      </details>
    );
  }

  return (
    <section aria-labelledby={headingId} className="border-t border-border px-4 py-2">
      <h4 id={headingId} className={`flex items-center gap-2 text-sm font-semibold ${styles.text}`}>
        <Icon className="size-4" aria-hidden="true" />
        {styles.label}
      </h4>
      <ul className="mt-2 space-y-2">
        {diagnostics.map((diagnostic, index): React.JSX.Element => (
          <li
            key={`${diagnostic.severity}-${diagnostic.title}-${index}`}
            className={`min-w-0 rounded-sm border px-3 py-2 ${styles.section}`}
          >
            <p className={`break-words text-sm font-medium ${styles.text}`}>{diagnostic.title}</p>
            {diagnostic.body !== "" && (
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs leading-4 text-foreground/85">
                {diagnostic.body.trim().replace(/\n(?:[ \t]*\n)+/g, "\n")}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
