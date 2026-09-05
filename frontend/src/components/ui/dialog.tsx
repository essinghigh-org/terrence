import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

function Dialog(props: DialogPrimitive.Root.Props): React.JSX.Element {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger(props: DialogPrimitive.Trigger.Props): React.JSX.Element {
  return <DialogPrimitive.Trigger {...props} />;
}

function DialogPortal(props: DialogPrimitive.Portal.Props): React.JSX.Element {
  return <DialogPrimitive.Portal {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props): React.JSX.Element {
  return <DialogPrimitive.Close {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Backdrop
      className={cn(
        "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm duration-200",
        "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  );
}

type DialogContentProps = DialogPrimitive.Popup.Props & {
  /** Motion/placement profile: centered modal (default) or top-docked drop-in. */
  readonly align?: "center" | "top";
  /** Suppress the built-in close affordance for surfaces with their own chrome. */
  readonly hideClose?: boolean;
};

// Motion lives here — next to the placement it belongs to — instead of being
// re-overridden per call site. Tailwind cannot dedupe cross-axis slide
// utilities (slide-in-from-top and slide-in-from-left compose, not merge),
// which is how the old mobile drawer inherited the centered modal's 48% Y
// offset and zoom and entered diagonally. Each profile below animates exactly
// one translation axis (plus opacity/scale), so no composition can reintroduce
// a diagonal.
const dialogMotionCenter =
  // Rise in from just below center, sink back out; scale and fade accompany.
  "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-open:slide-in-from-bottom-6 " +
  "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:slide-out-to-bottom-6";

const dialogMotionTop =
  // Drop in from just above the resting position, lift back up on close.
  // Single axis, no zoom, so command-palette results land immediately where
  // the eye expects them.
  "data-open:animate-in data-open:fade-in-0 data-open:slide-in-from-top-8 " +
  "data-closed:animate-out data-closed:fade-out-0 data-closed:slide-out-to-top-4";

function DialogContent({
  className,
  children,
  align = "center",
  hideClose = false,
  ...props
}: DialogContentProps): React.JSX.Element {
  const placement =
    align === "top"
      ? "left-1/2 top-[10dvh] -translate-x-1/2 translate-y-0"
      : "left-[50%] top-[50%] -translate-x-1/2 -translate-y-1/2";
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        className={cn(
          "fixed z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg gap-5 overflow-y-auto rounded-xl border bg-card p-6 text-card-foreground shadow-lg duration-200",
          placement,
          align === "top" ? dialogMotionTop : dialogMotionCenter,
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

// Side sheet anchored to a viewport edge (mobile navigation drawer, detail
// panels). Purely horizontal slide — no zoom, no vertical component — so it
// reads as the panel physically sliding out of the screen edge.
function DrawerContent({
  className,
  children,
  side = "left",
  hideClose = false,
  ...props
}: DialogContentProps & {
  readonly side?: "left" | "right";
}): React.JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        className={cn(
          "fixed z-50 flex w-[280px] max-w-[85vw] flex-col bg-background shadow-lg duration-200",
          side === "left"
            ? "left-0 border-r data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left"
            : "right-0 border-l data-open:animate-in data-open:slide-in-from-right data-closed:animate-out data-closed:slide-out-to-right",
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        className
      )}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      className={cn(
        "font-heading text-xl font-semibold leading-tight tracking-tight",
        className
      )}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DrawerContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
