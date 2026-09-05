import { Link } from "react-router-dom";
import { Copy } from "lucide-react";
import { Button, buttonVariants } from "./ui/button";
import { toast } from "./ui/toast";
import { copyTextToClipboard } from "../lib/utils";

export function WorkspaceGettingStarted({
  orgName, workspaceName, engine, source, hasRepository, localExecution, canQueueRun, canUpdate, canReadVariable,
}: Readonly<{
  orgName: string;
  workspaceName: string;
  engine: string;
  source?: string | undefined;
  hasRepository: boolean;
  localExecution: boolean;
  canQueueRun: boolean;
  canUpdate: boolean;
  canReadVariable: boolean;
}>): React.JSX.Element {
  const workspacePath = `/app/${encodeURIComponent(orgName)}/workspaces/${encodeURIComponent(workspaceName)}`;
  const cli = engine === "tofu" ? "tofu" : "terraform";
  const hostname = window.location.host;
  const configuration = `terraform {\n  backend "remote" {\n    hostname     = ${JSON.stringify(hostname)}\n    organization = ${JSON.stringify(orgName)}\n    workspaces {\n      name = ${JSON.stringify(workspaceName)}\n    }\n  }\n}`;
  const usesServerCode = !localExecution && (hasRepository || source === "local");

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Ready for your first plan</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {localExecution ? "Connect your CLI to store state in Terrence while running plans on your computer."
            : hasRepository ? "Your repository is connected. Add any required variables, then preview the changes in your code."
            : source === "local" ? "Mount your configuration directory on the Terrence server, then add any variables your code needs."
            : "Connect your existing configuration to this workspace. Your CLI uploads the code; Terrence keeps the state and run history together."}
        </p>
      </div>
      {!usesServerCode && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">1. Add this backend to your configuration</p>
              <Button size="icon-sm" variant="ghost" aria-label="Copy backend configuration" onClick={(): void => {
                void copyTextToClipboard(configuration).then((copied): void => {
                  toast.add({ title: copied ? "Backend configuration copied" : "Could not copy. Select and copy the configuration below.", type: copied ? "success" : "error" });
                });
              }}><Copy aria-hidden="true" /></Button>
            </div>
            <p className="text-xs text-muted-foreground">Use this in place of an existing backend or cloud block.</p>
            <pre className="overflow-x-auto rounded-md bg-muted/60 p-4 text-xs leading-relaxed"><code>{configuration}</code></pre>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">2. Sign in and run a plan from your code directory</p>
            <pre className="overflow-x-auto rounded-md bg-muted/60 p-4 text-xs leading-relaxed"><code>{`${cli} login ${hostname}\n${cli} init\n${cli} plan`}</code></pre>
            {window.location.protocol !== "https:" && <p className="text-sm text-muted-foreground">CLI login requires HTTPS. <Link className="underline underline-offset-4" to="/app/docs/reverse-proxy">Set up HTTPS</Link> and open Terrence at that address before copying the settings.</p>}
            <p className="text-xs text-muted-foreground">{localExecution ? "Plans execute on your computer. Terrence stores the state." : "The run appears here when the CLI uploads your configuration."}</p>
          </div>
        </>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {usesServerCode && canQueueRun && !localExecution && <Link className={buttonVariants({ size: "sm" })} to={`${workspacePath}/runs?new-run=true`}>Start first plan</Link>}
        {canReadVariable && <Link className={buttonVariants({ variant: "outline", size: "sm" })} to={`${workspacePath}/variables`}>Configure variables</Link>}
        {!hasRepository && canUpdate && <Link className="text-sm font-medium text-primary hover:underline" to={`${workspacePath}/settings/version-control`}>Connect a Git repository</Link>}
        <Link className="text-sm font-medium text-primary hover:underline" to="/app/docs/quickstart">Quick start guide</Link>
      </div>
    </div>
  );
}
