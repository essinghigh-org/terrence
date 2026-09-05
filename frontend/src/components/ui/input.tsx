import * as React from "react"

import { cn } from "@/lib/utils"

type InputProps = {} & React.InputHTMLAttributes<HTMLInputElement>

const inputComponent = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }: Readonly<InputProps>, ref: React.Ref<HTMLInputElement>): React.JSX.Element => {
    return (
      <input
        type={type}
        data-slot="input"
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-1.5 text-base text-foreground shadow-2xs sm:text-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/30 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
inputComponent.displayName = "Input"

export { inputComponent as Input }