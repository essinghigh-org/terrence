import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Cross2Icon } from "@radix-ui/react-icons";
import { cn } from "../../lib/utils";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

function Dialog(props: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>>): React.JSX.Element {
  return <DialogPrimitive.Root {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>)} />;
}

function DialogTrigger(props: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>>): React.JSX.Element {
  return <DialogPrimitive.Trigger {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>)} />;
}

function DialogPortal(props: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>>): React.JSX.Element {
  return <DialogPrimitive.Portal {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>)} />;
}

function DialogClose(props: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>>): React.JSX.Element {
  return <DialogPrimitive.Close {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>)} />;
}

function DialogOverlay({ className, ...props }: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>>): React.JSX.Element {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        className
      )}
      {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>)}
    />
  );
}

function DialogContent({ className, children, ...props }: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>>): React.JSX.Element {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg",
          className
        )}
        {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>)}
      >
        {children as React.ReactNode}
        <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <Cross2Icon className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({
  className,
  ...props
}: DeepReadonly<React.HTMLAttributes<HTMLDivElement>>): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col space-y-1.5 text-center sm:text-left",
        className
      )}
      {...(props as React.HTMLAttributes<HTMLDivElement>)}
    />
  );
}

function DialogFooter({
  className,
  ...props
}: DeepReadonly<React.HTMLAttributes<HTMLDivElement>>): React.JSX.Element {
  return (
    <div
      className={cn(
        "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
        className
      )}
      {...(props as React.HTMLAttributes<HTMLDivElement>)}
    />
  );
}

function DialogTitle({ className, ...props }: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>>): React.JSX.Element {
  return (
    <DialogPrimitive.Title
      className={cn(
        "text-lg font-semibold leading-none tracking-tight",
        className
      )}
      {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>)}
    />
  );
}

function DialogDescription({ className, ...props }: DeepReadonly<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>>): React.JSX.Element {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...(props as React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>)}
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
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
