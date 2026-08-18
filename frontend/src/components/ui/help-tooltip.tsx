import { useId, useState } from "react";
import { HelpCircle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type HelpTooltipProps = Readonly<{
  content: React.ReactNode;
  title?: string;
  icon?: "help" | "info";
  className?: string;
}>;

export function HelpTooltip({
  content,
  title,
  icon = "help",
  className,
}: HelpTooltipProps): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const tooltipId = useId();

  const IconComp = icon === "info" ? Info : HelpCircle;

  return (
    <div
      className="relative inline-flex items-center"
      onMouseEnter={(): void => { setIsOpen(true); }}
      onMouseLeave={(): void => { setIsOpen(false); }}
    >
      <button
        type="button"
        onClick={(): void => { setIsOpen(true); }}
        onFocus={(event): void => { if (event.currentTarget.matches(":focus-visible")) setIsOpen(true); }}
        onBlur={(): void => { setIsOpen(false); }}
        aria-label={title ?? "Help info"}
        aria-expanded={isOpen}
        aria-describedby={isOpen ? tooltipId : undefined}
        className={cn(
          "inline-flex items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      >
        <IconComp className="size-3.5" aria-hidden="true" />
      </button>

      {isOpen && (
        <div
          id={tooltipId}
          role="tooltip"
          className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-md border border-border bg-popover p-3 text-xs text-popover-foreground shadow-md transition-[opacity,transform] animate-in fade-in-0 zoom-in-95 duration-150"
        >
          {title !== undefined && (
            <div className="mb-1 font-semibold text-foreground">{title}</div>
          )}
          <div className="leading-normal text-muted-foreground">{content}</div>
          <div className="absolute top-full left-1/2 -mt-1 -translate-x-1/2 border-4 border-transparent border-t-popover" />
        </div>
      )}
    </div>
  );
}