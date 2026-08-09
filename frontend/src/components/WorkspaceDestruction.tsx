import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { fetchApi } from "@/lib/api";

type WorkspaceDeletionResource = {
  id: string;
  attributes: {
    name: string;
    "allow-destroy-plan"?: boolean;
    permissions?: {
      "can-force-delete"?: boolean;
      "can-queue-destroy"?: boolean;
      "can-update"?: boolean;
    };
  };
};

export function WorkspaceDestruction({
  workspace,
  onDeleted,
}: Readonly<{
  workspace: WorkspaceDeletionResource;
  onDeleted: () => void;
}>): React.JSX.Element {
  const navigate = useNavigate();
  const { orgName, workspaceName } = useParams<{ orgName: string; workspaceName: string }>();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [allowDestroyPlan, setAllowDestroyPlan] = useState(
    workspace.attributes["allow-destroy-plan"] !== false,
  );
  const [savingDestroySetting, setSavingDestroySetting] = useState(false);
  const [settingError, setSettingError] = useState("");
  const [queueingDestroy, setQueueingDestroy] = useState(false);
  const [queueError, setQueueError] = useState("");
  const canDelete = workspace.attributes.permissions?.["can-force-delete"] === true;
  const canQueueDestroy = workspace.attributes.permissions?.["can-queue-destroy"] === true;
  const canUpdate = workspace.attributes.permissions?.["can-update"] === true;
  const confirmed = confirmation === workspace.attributes.name;

  const updateAllowDestroyPlan = async (checked: boolean): Promise<void> => {
    if (!canUpdate || savingDestroySetting || queueingDestroy) return;
    setSavingDestroySetting(true);
    setSettingError("");
    try {
      await fetchApi(`/workspaces/${encodeURIComponent(workspace.id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            id: workspace.id,
            type: "workspaces",
            attributes: { "allow-destroy-plan": checked },
          },
        }),
      });
      setAllowDestroyPlan(checked);
    } catch (caught: unknown) {
      setSettingError(caught instanceof Error ? caught.message : "Failed to update destroy plan setting");
    } finally {
      setSavingDestroySetting(false);
    }
  };

  const queueDestroyPlan = async (): Promise<void> => {
    if (!canQueueDestroy || !allowDestroyPlan || savingDestroySetting || queueingDestroy) return;
    setQueueingDestroy(true);
    setQueueError("");
    try {
      const response = await fetchApi("/runs", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "runs",
            attributes: {
              "auto-apply": false,
              "is-destroy": true,
              message: "Destroy plan queued manually",
            },
            relationships: {
              workspace: { data: { type: "workspaces", id: workspace.id } },
            },
          },
        }),
      }) as { data?: { id?: unknown } };
      const runId = response.data?.id;
      if (typeof runId !== "string" || runId === "") {
        throw new Error("Destroy plan response did not include a run ID");
      }
      await navigate(
        `/app/${encodeURIComponent(orgName ?? "")}/workspaces/${encodeURIComponent(workspaceName ?? "")}/runs/${encodeURIComponent(runId)}`,
      );
    } catch (caught: unknown) {
      setQueueError(caught instanceof Error ? caught.message : "Failed to queue destroy plan");
      setQueueingDestroy(false);
    }
  };

  const setDialogOpen = (nextOpen: boolean): void => {
    if (deleting) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      setConfirmation("");
      setError("");
    }
  };

  const deleteWorkspace = async (event: React.SyntheticEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canDelete || !confirmed || deleting) return;

    setDeleting(true);
    setError("");
    try {
      await fetchApi(`/workspaces/${encodeURIComponent(workspace.id)}`, { method: "DELETE" });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Failed to delete workspace");
      setDeleting(false);
      return;
    }
    setDeleting(false);
    setOpen(false);
    setConfirmation("");
    onDeleted();
  };

  return (
    <Card className="max-w-3xl ring-destructive/30">
      <CardHeader>
        <CardTitle>Destruction and deletion</CardTitle>
        <CardDescription>
          Destroy managed infrastructure before permanently deleting its workspace data.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="destroy-infrastructure-heading" className="space-y-4">
          <div>
            <h3 id="destroy-infrastructure-heading" className="font-semibold">Destroy infrastructure</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Queue a plan that destroys all infrastructure managed by this workspace.
            </p>
          </div>
          <div className="flex items-start gap-3">
            <Checkbox
              id="allow-destroy-plans"
              checked={allowDestroyPlan}
              disabled={!canUpdate || savingDestroySetting || queueingDestroy}
              onCheckedChange={(checked: boolean): void => {
                void updateAllowDestroyPlan(checked);
              }}
            />
            <div className="space-y-1">
              <Label htmlFor="allow-destroy-plans">Allow destroy plans</Label>
              <p className="text-sm text-muted-foreground">
                When disabled, new destroy plans cannot be queued.
              </p>
            </div>
          </div>
          {savingDestroySetting && <p role="status" className="text-sm text-muted-foreground">Saving setting...</p>}
          {settingError !== "" && <p role="alert" className="text-sm text-destructive">{settingError}</p>}
          {!canUpdate && (
            <p role="status" className="text-sm text-muted-foreground">
              You do not have permission to change this setting.
            </p>
          )}
          <Button
            variant="outline"
            className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={!canQueueDestroy || !allowDestroyPlan || savingDestroySetting || queueingDestroy}
            onClick={(): void => { void queueDestroyPlan(); }}
          >
            {queueingDestroy && <Spinner data-icon="inline-start" />}
            {queueingDestroy ? "Queueing destroy plan" : "Queue destroy plan"}
          </Button>
          {queueError !== "" && <p role="alert" className="text-sm text-destructive">{queueError}</p>}
          {!canQueueDestroy && (
            <p role="status" className="text-sm text-muted-foreground">
              You do not have permission to queue a destroy plan.
            </p>
          )}
        </section>

        <Separator />

        <section aria-labelledby="delete-workspace-heading" className="flex flex-col items-start gap-4">
          <div>
            <h3 id="delete-workspace-heading" className="font-semibold">Delete workspace</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Permanently delete this workspace and its runs, state, variables, and settings.
            </p>
          </div>
          <p className="text-sm text-muted-foreground">
            This action cannot be undone. Infrastructure managed by the workspace is not destroyed.
          </p>
          <Dialog open={open} onOpenChange={setDialogOpen}>
            <DialogTrigger render={
              <Button variant="destructive" disabled={!canDelete}>
                <Trash2 data-icon="inline-start" />
                Delete workspace
              </Button>
            } />
            <DialogContent>
              <form onSubmit={deleteWorkspace}>
                <DialogHeader>
                  <DialogTitle>Delete {workspace.attributes.name}?</DialogTitle>
                  <DialogDescription>
                    Type <strong className="text-foreground">{workspace.attributes.name}</strong> to confirm
                    permanent deletion.
                  </DialogDescription>
                </DialogHeader>
                <div className="my-5 space-y-2">
                  <Label htmlFor="workspace-delete-confirmation">Workspace name</Label>
                  <Input
                    id="workspace-delete-confirmation"
                    value={confirmation}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                      setConfirmation(event.target.value);
                    }}
                    onInput={(event: React.SyntheticEvent<HTMLInputElement>): void => {
                      setConfirmation(event.currentTarget.value);
                    }}
                    autoComplete="off"
                    disabled={deleting}
                    aria-describedby={error === "" ? undefined : "workspace-delete-error"}
                    autoFocus
                  />
                  {error !== "" && (
                    <p id="workspace-delete-error" role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={deleting}
                    onClick={(): void => { setDialogOpen(false); }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="destructive" disabled={!confirmed || deleting || !canDelete}>
                    {deleting && <Spinner data-icon="inline-start" />}
                    {deleting ? "Deleting" : "Delete workspace permanently"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
          {!canDelete && (
            <p role="status" className="text-sm text-muted-foreground">
              You do not have permission to delete this workspace.
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
