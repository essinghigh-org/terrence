import * as React from "react"
import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({ className, ...props }: React.ComponentProps<"svg">): React.JSX.Element {
  const isAccessible = props["aria-label"] != null || props["aria-labelledby"] != null || props.role != null
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
