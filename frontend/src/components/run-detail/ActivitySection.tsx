import { History, MessageSquare } from "lucide-react";
import { formatDate, RUN_EVENT_LABELS } from "@/lib/run-detail-format";
import { formatRunSource, formatRunStatus } from "@/lib/run-labels";
import { TERMINAL_STATUSES, type RunComment, type RunEvent } from "@/lib/run-view-state";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

function hasAvatarUrl(value: string | null | undefined): value is string {
  return value !== undefined && value !== null && value !== "";
}

function ActivityEventRow({ event }: Readonly<{ event: RunEvent }>): React.JSX.Element {
  const actor = event.attributes["actor-username"] ?? "System";
  const fromStatus = event.attributes.details?.fromStatus;
  const toStatus = event.attributes.details?.toStatus;
  const eventSource = event.attributes.details?.source;
  const triggerReason = event.attributes.details?.triggerReason;
  // SAFETY: unknown event actions fall through to the status label fallback.
  const eventLabel = (RUN_EVENT_LABELS as Readonly<Record<string, string | undefined>>)[event.attributes.action]
    ?? formatRunStatus(event.attributes.action);
  const actorAvatarUrl = event.attributes["actor-avatar-url"];
  return (
    <li className="flex gap-3 px-5 py-3">
      <Avatar className="size-8 rounded-full">
        {hasAvatarUrl(actorAvatarUrl) ? (
          <AvatarImage src={actorAvatarUrl} alt={actor} className="rounded-full object-cover" />
        ) : (
          <AvatarFallback className="rounded-full bg-muted text-xs font-semibold text-muted-foreground">
            {actor.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        )}
      </Avatar>
      <div className="min-w-0 flex-1 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-foreground/85">
            <span className="font-semibold text-foreground">{actor}</span>{" "}
            {eventLabel}
          </p>
          <time
            className="text-xs text-muted-foreground"
            dateTime={event.attributes["created-at"]}
          >
            {formatDate(event.attributes["created-at"])}
          </time>
        </div>
        {fromStatus !== undefined && toStatus !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatRunStatus(fromStatus)} → {formatRunStatus(toStatus)}
          </p>
        )}
        {event.attributes.action === "create" && eventSource !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {formatRunStatus(triggerReason ?? "manual")} from {formatRunSource(eventSource, triggerReason)}
          </p>
        )}
      </div>
    </li>
  );
}

function CommentRow({ comment }: Readonly<{ comment: RunComment }>): React.JSX.Element {
  const commentAvatarUrl = comment.attributes["actor-avatar-url"];
  const commentActorName = comment.attributes["actor-username"];
  return (
    <article className="px-5 py-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-2 font-medium text-foreground/85">
          <Avatar className="size-5 rounded-full">
            {hasAvatarUrl(commentAvatarUrl) ? (
              <AvatarImage src={commentAvatarUrl} alt={commentActorName ?? "User"} className="rounded-full object-cover" />
            ) : (
              <AvatarFallback className="rounded-full bg-muted text-[9px] text-muted-foreground">
                {(commentActorName ?? "S").slice(0, 2).toUpperCase()}
              </AvatarFallback>
            )}
          </Avatar>
          {commentActorName ?? "System"}
        </span>
        <time dateTime={comment.attributes["created-at"]}>{formatDate(comment.attributes["created-at"])}</time>
      </div>
      <p className="whitespace-pre-wrap text-sm text-foreground/85">{comment.attributes.body}</p>
    </article>
  );
}

export function CommentForm({ commentBody, onCommentBodyChange, pendingAction, onSubmit }: Readonly<{
  commentBody: string;
  onCommentBodyChange: (body: string) => void;
  pendingAction: string;
  onSubmit: (event: React.SyntheticEvent<HTMLFormElement>) => void;
}>): React.JSX.Element {
  return (
    <form onSubmit={(event): void => { onSubmit(event); }} className="border-t border-border p-5">
      <label htmlFor="run-comment" className="mb-2 block text-sm font-medium text-foreground">Add a comment</label>
      <Textarea
        id="run-comment"
        name="run-comment"
        autoComplete="off"
        spellCheck={false}
        rows={3}
        value={commentBody}
        onChange={(event): void => { onCommentBodyChange(event.target.value); }}
        placeholder="Share context about this run"
      />
      <div className="mt-2 flex justify-end">
        <Button type="submit" disabled={commentBody.trim() === "" || pendingAction !== ""}>Add comment</Button>
      </div>
    </form>
  );
}

export type ActivitySectionProps = Readonly<{
  status: string;
  runEvents: readonly RunEvent[];
  comments: readonly RunComment[];
  canComment: boolean;
  commentBody: string;
  onCommentBodyChange: (body: string) => void;
  pendingAction: string;
  onCommentSubmit: (event: React.SyntheticEvent<HTMLFormElement>) => void;
}>;

export function ActivitySection(props: ActivitySectionProps): React.JSX.Element {
  const { status, runEvents, comments } = props;
  const showCombinedEmptyActivity = TERMINAL_STATUSES.has(status)
    && runEvents.length === 0
    && comments.length === 0;
  const commentForm = props.canComment ? (
    <CommentForm
      commentBody={props.commentBody}
      onCommentBodyChange={props.onCommentBodyChange}
      pendingAction={props.pendingAction}
      onSubmit={(event): void => { props.onCommentSubmit(event); }}
    />
  ) : null;

  if (showCombinedEmptyActivity) {
    return (
      <section aria-labelledby="activity-heading" className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <History className="size-5 text-muted-foreground/70" aria-hidden="true" />
          <MessageSquare className="size-5 text-muted-foreground/70" aria-hidden="true" />
          <h3 id="activity-heading" className="font-semibold text-foreground">Activity &amp; comments</h3>
          <span className="text-xs text-muted-foreground">0</span>
        </div>
        <p className="px-5 py-4 text-sm text-muted-foreground">No run activity or comments yet.</p>
        {commentForm}
      </section>
    );
  }
  return (
    <>
      <section aria-labelledby="activity-heading" className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <History className="size-5 text-muted-foreground/70" aria-hidden="true" />
          <h3 id="activity-heading" className="font-semibold text-foreground">Activity</h3>
          <span className="text-xs text-muted-foreground">{runEvents.length}</span>
        </div>
        {runEvents.length === 0 ? (
          <p className="px-5 py-3 text-xs text-muted-foreground">No run activity yet.</p>
        ) : (
          <ol className="divide-y divide-border/60">
            {runEvents.map((event: RunEvent): React.JSX.Element => (
              <ActivityEventRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="comments-heading" className="rounded-lg border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <MessageSquare className="size-5 text-muted-foreground/70" aria-hidden="true" />
          <h3 id="comments-heading" className="font-semibold text-foreground">Comments</h3>
          <span className="text-xs text-muted-foreground">{comments.length}</span>
        </div>
        <div className="divide-y divide-border/60">
          {comments.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted-foreground">No comments yet.</p>
          ) : comments.map((comment: RunComment): React.JSX.Element => (
            <CommentRow key={comment.id} comment={comment} />
          ))}
        </div>
        {commentForm}
      </section>
    </>
  );
}
