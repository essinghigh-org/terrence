"use client";

import type { JSX, ComponentProps } from "react";
import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";

import { cn } from "../../lib/utils";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

type AvatarProps = DeepReadonly<AvatarPrimitive.Root.Props> & Readonly<{
  readonly size?: "default" | "sm" | "lg";
}>;

function Avatar({
  className,
  size = "default",
  ...props
}: AvatarProps): JSX.Element {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      data-size={size}
      className={cn(
        "group/avatar relative flex size-8 shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken data-[size=lg]:size-10 data-[size=sm]:size-6 dark:after:mix-blend-lighten",
        className
      )}
      // SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as AvatarPrimitive.Root.Props)}
    />
  );
}

function AvatarImage({ className, ...props }: DeepReadonly<AvatarPrimitive.Image.Props>): JSX.Element {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn(
        "aspect-square size-full rounded-full object-cover",
        className
      )}
      // SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as AvatarPrimitive.Image.Props)}
    />
  );
}

function AvatarFallback({
  className,
  ...props
}: DeepReadonly<AvatarPrimitive.Fallback.Props>): JSX.Element {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn(
        "flex size-full items-center justify-center rounded-full bg-muted text-sm text-muted-foreground group-data-[size=sm]/avatar:text-xs",
        className
      )}
      // SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as AvatarPrimitive.Fallback.Props)}
    />
  );
}

function AvatarBadge({ className, ...props }: DeepReadonly<ComponentProps<"span">>): JSX.Element {
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground bg-blend-color ring-2 ring-background select-none",
        "group-data-[size=sm]/avatar:size-2 group-data-[size=sm]/avatar:[&>svg]:hidden",
        "group-data-[size=default]/avatar:size-2.5 group-data-[size=default]/avatar:[&>svg]:size-2",
        "group-data-[size=lg]/avatar:size-3 group-data-[size=lg]/avatar:[&>svg]:size-2",
        className
      )}
      // SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as ComponentProps<"span">)}
    />
  );
}

function AvatarGroup({ className, ...props }: DeepReadonly<ComponentProps<"div">>): JSX.Element {
  return (
    <div
      data-slot="avatar-group"
      className={cn(
        "group/avatar-group flex -space-x-2 *:data-[slot=avatar]:ring-2 *:data-[slot=avatar]:ring-background",
        className
      )}
      // SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as ComponentProps<"div">)}
    />
  );
}

function AvatarGroupCount({
  className,
  ...props
}: DeepReadonly<ComponentProps<"div">>): JSX.Element {
  return (
    <div
      data-slot="avatar-group-count"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm text-muted-foreground ring-2 ring-background group-has-data-[size=lg]/avatar-group:size-10 group-has-data-[size=sm]/avatar-group:size-6 [&>svg]:size-4 group-has-data-[size=lg]/avatar-group:[&>svg]:size-5 group-has-data-[size=sm]/avatar-group:[&>svg]:size-3",
        className
      )}
      // SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
      {...(props as ComponentProps<"div">)}
    />
  );
}

export {
  Avatar,
  AvatarImage,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarBadge,
};
