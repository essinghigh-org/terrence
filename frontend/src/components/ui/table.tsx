import * as React from "react"

import { cn } from "@/lib/utils"

export type TableDensity = "comfortable" | "dense"

const TableDensityContext = React.createContext<TableDensity>("comfortable")

function Table({ className, density = "comfortable", ...props }: Readonly<React.ComponentProps<"table"> & { readonly density?: TableDensity }>): React.JSX.Element {
  return (
    <TableDensityContext.Provider value={density}>
      <div
        data-slot="table-container"
        className="relative w-full overflow-x-auto"
      >
        <table
          data-slot="table"
          data-density={density}
          className={cn("w-full caption-bottom text-sm", className)}
          {...props}
        />
      </div>
    </TableDensityContext.Provider>
  )
}

function TableHeader({ className, ...props }: Readonly<React.ComponentProps<"thead">>): React.JSX.Element {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: Readonly<React.ComponentProps<"tbody">>): React.JSX.Element {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: Readonly<React.ComponentProps<"tfoot">>): React.JSX.Element {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: Readonly<React.ComponentProps<"tr">>): React.JSX.Element {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: Readonly<React.ComponentProps<"th">>): React.JSX.Element {
  const density = React.useContext(TableDensityContext)
  return (
    <th
      data-slot="table-head"
      className={cn(
        density === "dense"
          ? "h-8 px-3 text-left align-middle text-xs font-medium tracking-wide text-muted-foreground whitespace-nowrap [&:has([role=checkbox])]:pr-0"
          : "h-11 px-4 text-left align-middle text-xs font-medium tracking-wide text-muted-foreground whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: Readonly<React.ComponentProps<"td">>): React.JSX.Element {
  const density = React.useContext(TableDensityContext)
  return (
    <td
      data-slot="table-cell"
      className={cn(
        density === "dense"
          ? "px-3 py-1.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0"
          : "px-4 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: Readonly<React.ComponentProps<"caption">>): React.JSX.Element {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
}