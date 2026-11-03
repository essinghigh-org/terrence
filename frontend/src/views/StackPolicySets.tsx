import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../components/ui/dialog";

type PolicySet = {
  id: string;
  attributes: { name: string; kind: string; global: boolean; "tag-selectors"?: unknown[] };
  relationships?: Record<string, { data?: { id: string }[] }>;
};
type ScopeAction = { policy: PolicySet; relationship: "stacks" | "stack-exclusions"; remove: boolean };

export function stackScopeAction(policy: PolicySet, stackId: string): ScopeAction {
  const relationship = policy.attributes.global ? "stack-exclusions" : "stacks";
  return {
    policy,
    relationship,
    remove: policy.relationships?.[relationship]?.data?.some((s): boolean => s.id === stackId) === true,
  };
}

export function StackPolicySets({
  orgName,
  stack,
  canManage,
  onClose,
}: Readonly<{
  orgName: string;
  stack: { id: string; attributes: { name: string } };
  canManage: boolean;
  onClose: () => void;
}>): React.JSX.Element {
  const [policies, setPolicies] = useState<PolicySet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<ScopeAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect((): (() => void) => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const load = async (): Promise<void> => {
      try {
        const all: PolicySet[] = [];
        let page: number | null = 1;
        while (page !== null) {
          const response = (await fetchApi(
            `/organizations/${encodeURIComponent(orgName)}/policy-sets?page[size]=100&page[number]=${page}`,
            { signal: controller.signal },
          )) as { data: PolicySet[]; meta?: { pagination?: { "next-page"?: number | null } } };
          all.push(...response.data);
          page = response.meta?.pagination?.["next-page"] ?? null;
        }
        if (!controller.signal.aborted) setPolicies(all.filter((p): boolean => p.attributes.kind === "tfpolicy"));
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : "Failed to load policy sets.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return (): void => {
      controller.abort();
    };
  }, [orgName, revision]);
  const save = async (): Promise<void> => {
    if (pending === null || !canManage) return;
    setSaving(true);
    setError("");
    try {
      await fetchApi(`/policy-sets/${encodeURIComponent(pending.policy.id)}/relationships/${pending.relationship}`, {
        method: pending.remove ? "DELETE" : "POST",
        body: JSON.stringify({ data: [{ id: stack.id, type: "stacks" }] }),
      });
      setPending(null);
      setRevision((value): number => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to update Stack policy scope.");
      setPending(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open): void => {
          if (!open && !saving) onClose();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Policies for {stack.attributes.name}</DialogTitle>
            <DialogDescription>
              Manage explicit Stack inclusions and exclusions for tfpolicy policy sets.
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-md border border-warning/30 bg-warning/10 p-3 text-sm" role="note">
            tfpolicy execution is not supported. Applicable tfpolicy policy sets block Stack deployments rather than
            silently skipping checks. Adding a version to the catalog does not enable execution.
          </p>
          <p className="text-sm text-muted-foreground">
            Project and tag scopes can also apply. This list shows explicit Stack scope, not a complete effective-policy
            evaluation.
          </p>
          {error !== "" && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {loading ? (
            <p role="status">Loading policy sets…</p>
          ) : (
            <div className="max-h-96 space-y-3 overflow-y-auto">
              {policies.length === 0 && <p>No tfpolicy policy sets found.</p>}
              {policies.map((policy): React.JSX.Element => {
                const action = stackScopeAction(policy, stack.id);
                const tagged = (policy.attributes["tag-selectors"]?.length ?? 0) > 0;
                return (
                  <div key={policy.id} className="rounded-md border p-3 space-y-2">
                    <Link
                      className="font-medium underline"
                      to={`/app/${encodeURIComponent(orgName)}/settings/policy-sets/${encodeURIComponent(policy.id)}`}
                    >
                      {policy.attributes.name}
                    </Link>
                    <p className="text-sm text-muted-foreground">
                      {policy.attributes.global
                        ? action.remove
                          ? "Global · Stack excluded"
                          : "Global · Stack not excluded"
                        : action.remove
                          ? "Stack explicitly included"
                          : "No explicit Stack inclusion"}
                    </p>
                    {tagged && <p className="text-sm">Tag-scoped sets cannot add explicit Stack scope.</p>}
                    {canManage && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={saving || (tagged && !action.remove)}
                        onClick={(): void => {
                          setPending(action);
                        }}
                      >
                        {policy.attributes.global
                          ? action.remove
                            ? "Remove exclusion"
                            : "Exclude Stack"
                          : action.remove
                            ? "Remove inclusion"
                            : "Include Stack"}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open): void => {
          if (!open && !saving) setPending(null);
        }}
        title="Change Stack policy scope"
        description="This changes which policy checks apply. Applicable tfpolicy sets block deployment because their executor is unsupported; exclusions can remove that protection. Other policy scopes may still apply."
        confirmText="Save scope"
        loading={saving}
        onConfirm={save}
      />
    </>
  );
}
