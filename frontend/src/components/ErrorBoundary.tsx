import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

type ErrorBoundaryState = Readonly<{ failed: boolean }>;

export class ErrorBoundary extends Component<Readonly<{ children: ReactNode }>, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { failed: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled UI error", error, info);
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <section role="alert" className="flex max-w-md flex-col gap-4 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="text-sm text-muted-foreground">
              Reload the page to recover. Your saved Terraform Enterprise data is unaffected.
            </p>
          </div>
          <Button onClick={(): void => { window.location.reload(); }}>Reload page</Button>
        </section>
      </main>
    );
  }
}
