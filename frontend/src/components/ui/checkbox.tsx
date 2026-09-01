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
        "peer h-4 w-4 shrink-0 rounded-sm border border-input shadow-2xs transition-colors focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-primary data-checked:border-primary data-checked:text-primary-foreground",
        className
      )}
      // SAFETY: DeepReadonly is a compile-time-only structural wrapper; the props object is the primitive's own shape at runtime.
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