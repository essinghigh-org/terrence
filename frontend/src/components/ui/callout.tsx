import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A tinted notice panel: an icon, a heading, an explanation, and optionally
 * some actions.
 *
 * This exists because the app had grown four independent spellings of the same
 * thing — `DegradedBanner`, a hand-written amber panel in the run page, another
 * in the database-migration wizard, and a third in the create-workspace modal —
 * which had drifted apart in padding, radius, icon, and (worse) in colour:
 * three of them reached past the theme into raw `amber-500`/`amber-700`
 * Tailwind palette classes with their own `dark:` overrides, so they did not
 * follow the selected theme at all.
 *
 * Tones map to the semantic tokens, and the readable-text pairs
 * (`--warning-text`, `--success-text`) mean the copy clears 4.5:1 on the tint
 * without anyone mixing a colour by hand at the call site.
 */

export type CalloutTone = "info" | "success" | "warning" | "danger";

const TONE_CLASSES: Readonly<Record<CalloutTone, string>> = {
  info: "border-primary/25 bg-primary/5",
  success: "border-success/30 bg-success/10",
  warning: "border-warning/40 bg-warning/10",
  danger: "border-destructive/30 bg-destructive/10",
};

const TITLE_CLASSES: Readonly<Record<CalloutTone, string>> = {
  info: "text-foreground",
  success: "text-success-text",
  warning: "text-warning-text",
  danger: "text-destructive",
};

const ICON_CLASSES: Readonly<Record<CalloutTone, string>> = {
  info: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
};

const ICONS: Readonly<Record<CalloutTone, typeof Info>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
};

export function Callout({
  tone = "info",
  title,
  children,
  actions,
  className,
  role,
  "aria-label": ariaLabel,
}: Readonly<{
  tone?: CalloutTone;
  /** Optional: a callout can be a single line of prose with no heading. */
  title?: string;
  children?: React.ReactNode;
  /** Buttons or links, laid out below the body. */
  actions?: React.ReactNode;
  className?: string;
  /** "alert" for something that has just gone wrong; omit for static notes. */
  role?: "alert" | "status";
  "aria-label"?: string;
}>): React.JSX.Element {
  const ToneIcon = ICONS[tone];
  return (
    <section
      {...(role === undefined ? {} : { role })}
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      className={cn("rounded-lg border p-4 text-sm", TONE_CLASSES[tone], className)}
    >
      <div className="flex items-start gap-3">
        <ToneIcon
          className={cn("mt-0.5 size-4 shrink-0", ICON_CLASSES[tone])}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          {title !== undefined && (
            <p className={cn("font-semibold", TITLE_CLASSES[tone])}>{title}</p>
          )}
          {children !== undefined && (
            <div className={cn("max-w-prose text-muted-foreground", title === undefined ? "" : "mt-1")}>
              {children}
            </div>
          )}
          {actions !== undefined && (
            <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
          )}
        </div>
      </div>
    </section>
  );
}
