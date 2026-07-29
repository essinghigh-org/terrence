import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchApi } from "@/lib/api";

type RunTask = {
  id: string;
  attributes: {
    name: string;
    description?: string | null;
    enabled?: boolean;
  };
};

type WorkspaceRunTask = {
  id: string;
  attributes: {
    stage: string;
    "enforcement-level": string;
    "run-task-name"?: string;
    "run-task-description"?: string | null;
    "run-task-enabled"?: boolean;
  };
  relationships: {
    "run-task": { data: { id: string; type: string } };
  };
};

const stageOptions = [
  ["pre_plan", "Pre-plan"],
  ["post_plan", "Post-plan"],
  ["pre_apply", "Pre-apply"],
  ["post_apply", "Post-apply"],
] as const;

const enforcementOptions = [
  ["advisory", "Advisory"],
  ["mandatory", "Mandatory"],
  ["must_pass", "Must pass"],
] as const;

const messageFrom = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

export function WorkspaceRunTasks({
  orgName,
  workspaceId,
  canManage,
}: Readonly<{
  orgName: string;
  workspaceId: string;
  canManage: boolean;
}>): React.JSX.Element {
  const [tasks, setTasks] = useState<RunTask[]>([]);
  const [bindings, setBindings] = useState<WorkspaceRunTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [stage, setStage] = useState("post_plan");
  const [enforcementLevel, setEnforcementLevel] = useState("advisory");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      const taskRequest = canManage
        ? fetchApi(`/organizations/${encodeURIComponent(orgName)}/run-tasks`)
        : Promise.resolve({ data: [] });
      const [taskResponse, bindingResponse] = await Promise.all([
        taskRequest,
        fetchApi(`/workspaces/${encodeURIComponent(workspaceId)}/run-tasks`),
      ]) as [{ data?: RunTask[] }, { data?: WorkspaceRunTask[] }];
      setTasks(Array.isArray(taskResponse.data) ? taskResponse.data : []);
      setBindings(Array.isArray(bindingResponse.data) ? bindingResponse.data : []);
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to load run tasks"));
    } finally {
      setLoading(false);
    }
  }, [canManage, orgName, workspaceId]);

  useEffect((): void => {
    void load();
  }, [load]);

  const attachedTaskIds = useMemo(
    (): Set<string> => new Set(
      bindings.map((binding: WorkspaceRunTask): string =>
        binding.relationships["run-task"].data.id,
      ),
    ),
    [bindings],
  );
  const availableTasks = tasks.filter(
    (task: RunTask): boolean =>
      task.attributes.enabled !== false && !attachedTaskIds.has(task.id),
  );
  const tasksById = useMemo(
    (): Map<string, RunTask> => new Map(
      tasks.map((task: RunTask): [string, RunTask] => [task.id, task]),
    ),
    [tasks],
  );

  const attach = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!canManage || selectedTaskId === "" || saving !== null) return;
    setSaving("attach");
    setError("");
    setNotice("");
    try {
      await fetchApi(`/workspaces/${encodeURIComponent(workspaceId)}/run-tasks`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "workspace-run-tasks",
            attributes: {
              stage,
              "enforcement-level": enforcementLevel,
            },
            relationships: {
              "run-task": { data: { id: selectedTaskId, type: "run-tasks" } },
            },
          },
        }),
      });
      setSelectedTaskId("");
      await load();
      setNotice("Run task attached.");
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to attach run task"));
    } finally {
      setSaving(null);
    }
  };

  const remove = async (taskId: string): Promise<void> => {
    if (!canManage || saving !== null || !window.confirm("Remove this run task?")) return;
    setSaving(taskId);
    setError("");
    setNotice("");
    try {
      await fetchApi(
        `/workspaces/${encodeURIComponent(workspaceId)}/run-tasks/${encodeURIComponent(taskId)}`,
        { method: "DELETE" },
      );
      setBindings((current: WorkspaceRunTask[]): WorkspaceRunTask[] =>
        current.filter(
          (binding: WorkspaceRunTask): boolean =>
            binding.relationships["run-task"].data.id !== taskId,
        ),
      );
      setNotice("Run task removed.");
    } catch (caught: unknown) {
      setError(messageFrom(caught, "Failed to remove run task"));
    } finally {
      setSaving(null);
    }
  };

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>Run tasks</CardTitle>
        <CardDescription>
          Run external checks at defined stages in this workspace&apos;s run lifecycle.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canManage ? (
          <form onSubmit={attach}>
            <FieldGroup className="md:grid md:grid-cols-3">
              <Field data-disabled={loading || saving !== null}>
                <FieldLabel htmlFor="workspace-run-task">Run task</FieldLabel>
                <Select
                  id="workspace-run-task"
                  value={selectedTaskId}
                  onValueChange={setSelectedTaskId}
                  disabled={loading || saving !== null || availableTasks.length === 0}
                >
                  <SelectItem value="">
                    {availableTasks.length === 0 ? "No available run tasks" : "Select a run task"}
                  </SelectItem>
                  {availableTasks.map((task: RunTask): React.JSX.Element => (
                    <SelectItem key={task.id} value={task.id}>
                      {task.attributes.name}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              <Field data-disabled={loading || saving !== null}>
                <FieldLabel htmlFor="workspace-run-task-stage">Stage</FieldLabel>
                <Select
                  id="workspace-run-task-stage"
                  value={stage}
                  onValueChange={setStage}
                  disabled={loading || saving !== null}
                >
                  {stageOptions.map(([value, label]): React.JSX.Element => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </Select>
              </Field>
              <Field data-disabled={loading || saving !== null}>
                <FieldLabel htmlFor="workspace-run-task-enforcement">Enforcement</FieldLabel>
                <Select
                  id="workspace-run-task-enforcement"
                  value={enforcementLevel}
                  onValueChange={setEnforcementLevel}
                  disabled={loading || saving !== null}
                >
                  {enforcementOptions.map(([value, label]): React.JSX.Element => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </Select>
              </Field>
              <Button
                type="submit"
                className="self-start md:col-span-3"
                disabled={selectedTaskId === "" || saving !== null}
              >
                {saving === "attach" && <Spinner data-icon="inline-start" />}
                {saving === "attach" ? "Attaching" : "Attach run task"}
              </Button>
            </FieldGroup>
          </form>
        ) : (
          <FieldDescription>
            You can view attached run tasks, but only workspace administrators with run task access can change them.
          </FieldDescription>
        )}

        <div className="flex items-center gap-3">
          <FieldError>{error}</FieldError>
          {error !== "" && (
            <Button size="sm" variant="outline" onClick={(): void => { void load(); }}>
              Try again
            </Button>
          )}
          {error === "" && <span role="status" className="text-sm text-muted-foreground">{notice}</span>}
        </div>

        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run task</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Enforcement</TableHead>
                {canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell colSpan={canManage ? 4 : 3} className="h-20 text-center text-muted-foreground">
                    Loading run tasks…
                  </TableCell>
                </TableRow>
              )}
              {!loading && bindings.map((binding: WorkspaceRunTask): React.JSX.Element => {
                const taskId = binding.relationships["run-task"].data.id;
                const task = tasksById.get(taskId);
                const taskName = task?.attributes.name ?? binding.attributes["run-task-name"] ?? taskId;
                const taskDescription = task?.attributes.description
                  ?? binding.attributes["run-task-description"];
                const taskEnabled = task?.attributes.enabled
                  ?? binding.attributes["run-task-enabled"];
                const stageLabel = stageOptions.find(([value]): boolean =>
                  value === binding.attributes.stage)?.[1] ?? binding.attributes.stage;
                const enforcementLabel = enforcementOptions.find(([value]): boolean =>
                  value === binding.attributes["enforcement-level"])?.[1]
                  ?? binding.attributes["enforcement-level"];
                return (
                  <TableRow key={binding.id}>
                    <TableCell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{taskName}</span>
                          {taskEnabled === false && <Badge variant="secondary">Disabled</Badge>}
                        </div>
                        {taskDescription != null && taskDescription !== "" && (
                          <span className="max-w-md whitespace-normal text-sm text-muted-foreground">
                            {taskDescription}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell><Badge variant="outline">{stageLabel}</Badge></TableCell>
                    <TableCell>
                      <Badge variant={binding.attributes["enforcement-level"] === "advisory" ? "outline" : "secondary"}>
                        {enforcementLabel}
                      </Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="destructive"
                          aria-label={`Remove ${taskName}`}
                          disabled={saving !== null}
                          onClick={(): void => { void remove(taskId); }}
                        >
                          {saving === taskId && <Spinner data-icon="inline-start" />}
                          {saving === taskId ? "Removing" : "Remove"}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
              {!loading && error === "" && bindings.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canManage ? 4 : 3} className="h-20 text-center text-muted-foreground">
                    No run tasks are attached to this workspace.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
