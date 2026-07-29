import type { JSX, HTMLAttributes } from "react";

type DeepReadonly<T> = T extends null | undefined
  ? T
  : T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type BadgeProps = Readonly<{
  readonly variant?: "default" | "secondary" | "destructive" | "outline";
}> & DeepReadonly<HTMLAttributes<HTMLDivElement>>;

export function Badge({ className = "", variant = "default", ...props }: BadgeProps): JSX.Element {
  const baseStyle = "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold leading-5 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";
  const variantStyles = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    destructive: "bg-destructive text-destructive-foreground",
    outline: "border border-border text-foreground",
  };

  const styleClass = variantStyles[variant];

  return (
    <div className={`${baseStyle} ${styleClass} ${className}`} {...(props as HTMLAttributes<HTMLDivElement>)} />
  );
}
