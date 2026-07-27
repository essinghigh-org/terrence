import * as React from "react"
import { cn } from "@/lib/utils"

function Select({
  children,
  value,
  onValueChange,
  defaultValue,
  className,
  id,
  ...props
}: Omit<React.ComponentProps<"select">, "value" | "defaultValue" | "onChange"> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children?: React.ReactNode
}) {
  return (
    <div className="relative w-full">
      <select
        id={id}
        data-slot="select"
        value={value}
        defaultValue={defaultValue}
        onChange={(e) => onValueChange?.(e.target.value)}
        className={cn(
          "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
          className
        )}
        {...props}
      >
        {children}
      </select>
    </div>
  )
}

function SelectTrigger(_props: React.ComponentProps<"div">) {
  return null;
}

function SelectValue(_props: { placeholder?: string }) {
  return null;
}

function SelectContent({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function SelectItem({ value, children }: { value: string; children?: React.ReactNode }) {
  return <option value={value}>{children}</option>;
}

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
}
