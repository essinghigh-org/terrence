import * as React from "react";

export type BadgeProps = {
  variant?: "default" | "secondary" | "destructive" | "outline";
} & React.HTMLAttributes<HTMLDivElement>

export function Badge({ className = "", variant = "default", ...props }: BadgeProps) {
  const baseStyle = "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";
  const variantStyles = {
    default: "bg-blue-600 text-white hover:bg-blue-700",
    secondary: "bg-gray-100 text-gray-900 hover:bg-gray-200",
    destructive: "bg-red-500 text-white hover:bg-red-600",
    outline: "text-gray-900 border border-gray-200",
  };

  return (
    <div className={`${baseStyle} ${variantStyles[variant] || variantStyles.default} ${className}`} {...props} />
  );
}
