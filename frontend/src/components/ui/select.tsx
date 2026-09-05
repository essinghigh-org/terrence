import * as React from "react"
import { cn } from "@/lib/utils"

function Select({
  children,
  value,
  onValueChange,
  onChange,
  defaultValue,
  className,
  id,
  ...props
}: Readonly<Omit<React.ComponentProps<"select">, "value" | "defaultValue"> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children?: React.ReactNode
}>): React.JSX.Element {
  return (
      <select
        id={id}
        data-slot="select"
        value={value}
        defaultValue={defaultValue}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>): void => {
          onChange?.(event);
          onValueChange?.(event.target.value);
        }}
        className={cn(
          "h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1.5 text-base text-foreground shadow-2xs sm:text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      >
        {children}
      </select>
  )
}

function SelectTrigger(_props: Readonly<React.ComponentProps<"div">>): null {
  return null;
}

function SelectValue(_props: Readonly<{ placeholder?: string }>): null {
  return null;
}

function SelectContent({ children }: Readonly<{ children?: React.ReactNode }>): React.JSX.Element {
  return <>{children}</>;
}

function SelectItem({ value, children }: Readonly<{ value: string; children?: React.ReactNode }>): React.JSX.Element {
  return <option value={value}>{children}</option>;
}

export {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
}