import * as React from "react"
import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const isAccessible = Boolean(props["aria-label"] || props["aria-labelledby"] || props.role)
  return (
    <Loader2Icon
      data-slot="spinner"
      aria-hidden={isAccessible ? undefined : "true"}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
