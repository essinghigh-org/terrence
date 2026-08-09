import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { Check } from "lucide-react";

import { cn } from "../../lib/utils";

type CheckboxProps = CheckboxPrimitive.Root.Props;

function Checkbox({ className, ...props }: CheckboxProps): React.JSX.Element {
  return (
    <CheckboxPrimitive.Root
      nativeButton
      render={<button type="button" />}
      className={cn(
        "peer h-4 w-4 shrink-0 rounded-sm border border-primary shadow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary data-checked:text-primary-foreground",
        className
      )}
      {...(props as CheckboxPrimitive.Root.Props)}
    >
      <CheckboxPrimitive.Indicator
        className={cn("flex items-center justify-center text-current")}
      >
        <Check className="h-4 w-4" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
export type { CheckboxProps };