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
  const baseStyle = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";
  const variantStyles = {
    default: "bg-blue-600 text-white hover:bg-blue-700",
    secondary: "bg-gray-100 text-gray-900 hover:bg-gray-200",
    destructive: "bg-red-500 text-white hover:bg-red-600",
    outline: "text-gray-900 border border-gray-200",
  };

  const styleClass = variantStyles[variant];

  return (
    <div className={`${baseStyle} ${styleClass} ${className}`} {...(props as HTMLAttributes<HTMLDivElement>)} />
  );
}
