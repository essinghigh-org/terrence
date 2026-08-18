import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const toast = ToastPrimitive.createToastManager();

function ToastIcon({ type }: Readonly<{ type: string | undefined }>): React.JSX.Element | null {
  if (type === "success") return <CircleCheckIcon aria-hidden="true" />;
  if (type === "info") return <InfoIcon aria-hidden="true" />;
  if (type === "warning") return <TriangleAlertIcon aria-hidden="true" />;
  if (type === "error") return <OctagonXIcon aria-hidden="true" className="text-destructive" />;
  if (type === "loading") return <Loader2Icon aria-hidden="true" className="animate-spin" />;
  return null;
}

function ToastList(): React.JSX.Element[] {
  const { toasts } = ToastPrimitive.useToastManager();

  return toasts.map((item): React.JSX.Element => (
    <ToastPrimitive.Root
      key={item.id}
      toast={item}
      className={cn(
        "pointer-events-auto relative w-full rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none",
        "data-starting-style:translate-y-full data-ending-style:translate-y-full",
      )}
    >
      <ToastPrimitive.Content className="flex items-center gap-3 p-4">
        <span className="shrink-0 [&_svg]:size-4">
          <ToastIcon type={item.type} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <ToastPrimitive.Title className="text-sm font-medium" />
          <ToastPrimitive.Description className="text-sm text-muted-foreground" />
        </div>
        <ToastPrimitive.Action render={<Button variant="outline" size="sm" />} />
        <ToastPrimitive.Close
          aria-label="Close notification"
          render={<Button variant="ghost" size="icon-sm" />}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <XIcon aria-hidden="true" />
        </ToastPrimitive.Close>
      </ToastPrimitive.Content>
    </ToastPrimitive.Root>
  ));
}

function Toaster(): React.JSX.Element {
  return (
    <ToastPrimitive.Provider toastManager={toast}>
      <ToastPrimitive.Portal>
        <ToastPrimitive.Viewport className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2 outline-none">
          <ToastList />
        </ToastPrimitive.Viewport>
      </ToastPrimitive.Portal>
    </ToastPrimitive.Provider>
  );
}

export { Toaster, toast };