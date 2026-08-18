import { useId } from "react";
import { AlertTriangle, XCircle } from "lucide-react";
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
}>): React.JSX.Element | null {
  const { severity, diagnostics } = props;
  const headingId = useId();
  if (diagnostics.length === 0) return null;
  const styles = SEVERITY_STYLES[severity];
  const Icon = styles.icon;
  return (
    <section aria-labelledby={headingId} className={`border-t ${styles.section} px-5 py-4`}>
      <h4 id={headingId} className={`flex items-center gap-2 text-sm font-semibold ${styles.text}`}>
        <Icon className="size-4" aria-hidden="true" />
        {styles.label}
      </h4>
      <ul className="mt-3 space-y-3">
        {diagnostics.map((diagnostic, index): React.JSX.Element => (
          <li
            key={`${diagnostic.severity}-${diagnostic.title}-${index}`}
            className="overflow-hidden rounded-md border border-border bg-background p-3"
          >
            <p className={`text-sm font-medium ${styles.text}`}>{diagnostic.title}</p>
            {diagnostic.body !== "" && (
              <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5 text-foreground/85">
                {diagnostic.body}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
