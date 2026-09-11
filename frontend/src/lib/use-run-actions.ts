import { useCallback, useRef, useState } from "react";
import { fetchApi } from "./api";
import { ACTION_CONFIRMATIONS, type RunActionKind } from "./run-decision";
import type { AuxKind } from "./run-view-state";
import { toast } from "../components/ui/toast";

export type CommentSubmitHandler = (
  event: React.SyntheticEvent<HTMLFormElement>,
) => Promise<void>;

export type RunActions = Readonly<{
  /** The action currently being sent, or "" when idle. */
  pendingAction: string;
  /** Pending value for the decision panel ("comment" posts must not read as run-action work). */
  decisionPending: string;
  performRunAction: (action: RunActionKind, successTitle: string, comment?: string) => Promise<boolean>;
  handleDecisionConfirm: (action: RunActionKind, comment: string) => void;
  commentBody: string;
  setCommentBody: (body: string) => void;
  handleCommentSubmit: CommentSubmitHandler;
}>;

export type UseRunActionsArgs = Readonly<{
  runId: string;
  markActionSent: (action: string) => void;
  markActionSettled: () => void;
  refreshAll: () => void;
  refresh: (kinds: readonly AuxKind[]) => void;
}>;

export function useRunActions(args: UseRunActionsArgs): RunActions {
  const { runId, markActionSent, markActionSettled, refreshAll, refresh } = args;
  const [pendingAction, setPendingAction] = useState("");
  const [commentBody, setCommentBody] = useState("");
  // Synchronous guard: state updates land on re-render, so two rapid
  // submissions could both pass a state check and send duplicate POSTs.
  const actionInFlightRef = useRef(false);

  /**
   * Send a run action.
   *
   * `markActionSent` records that the run was asked to move, so the decision
   * panel reports the action as in flight until the run's status actually
   * changes. Without it, the refresh that follows the POST usually lands
   * before the worker has picked the job up, so the page re-rendered the same
   * "Apply changes" button it had just accepted a click on — which reads as
   * the click having failed.
   */
  const performRunAction = useCallback(async (
    action: RunActionKind,
    successTitle: string,
    comment = "",
  ): Promise<boolean> => {
    if (actionInFlightRef.current) return false;
    actionInFlightRef.current = true;
    setPendingAction(action);
    try {
      const trimmedComment = comment.trim();
      const actionBody = {
        method: "POST",
        ...(trimmedComment !== "" ? {
          body: JSON.stringify({
            data: {
              type: "runs",
              attributes: { comment: trimmedComment },
            },
          }),
        } : undefined),
      };
      await fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/actions/${action}`, actionBody);
      toast.add({ title: successTitle, type: "success" });
      markActionSent(action);
      return true;
    } catch (error: unknown) {
      toast.add({
        title: error instanceof Error ? error.message : `Failed to ${action.replace("-", " ")} run`,
        type: "error",
      });
      // The action never took, so the page must go back to offering it.
      markActionSettled();
      refreshAll();
      return false;
    } finally {
      setPendingAction("");
      actionInFlightRef.current = false;
    }
  }, [runId, markActionSent, markActionSettled, refreshAll]);

  const handleDecisionConfirm = useCallback((action: RunActionKind, comment: string): void => {
    void performRunAction(action, ACTION_CONFIRMATIONS[action].successTitle, comment);
  }, [performRunAction]);

  async function handleCommentSubmit(event: React.SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const body = commentBody.trim();
    if (body === "") return;
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setPendingAction("comment");
    try {
      await fetchApi(`/api/v2/runs/${encodeURIComponent(runId)}/comments`, {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "comments",
            attributes: { body },
          },
        }),
      });
      setCommentBody("");
      toast.add({ title: "Comment added", type: "success" });
      // Only the comment list changed; reloading the whole run to see it was
      // eight redundant requests per comment.
      refresh(["comments"]);
    } catch (error: unknown) {
      toast.add({
        title: error instanceof Error ? error.message : "Failed to add comment",
        type: "error",
      });
    } finally {
      setPendingAction("");
      actionInFlightRef.current = false;
    }
  }

  // The comment form shares pendingAction ("comment" while posting):
  // the panel must not report that as run-action work.
  const decisionPending = pendingAction === "comment" ? "" : pendingAction;

  return {
    pendingAction,
    decisionPending,
    performRunAction,
    handleDecisionConfirm,
    commentBody,
    setCommentBody,
    handleCommentSubmit,
  };
}
