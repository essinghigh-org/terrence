import { Link } from "react-router-dom";
import { formatDate, formatDurationSeconds, timestampMilliseconds } from "@/lib/run-detail-format";
import type { PlanCountSource } from "@/lib/run-detail-model";
import { formatRunStatus } from "@/lib/run-labels";
import { isNumber } from "@/lib/type-guards";
import type { RunAttributes } from "@/lib/run-view-state";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { Disclosure } from "../ui/disclosure";
import { MetaList } from "../ui/meta-list";
import { ResourceCounts } from "./phase-bits";

export type RunDetailsCardProps = Readonly<{
  attributes: RunAttributes;
  status: string;
  duration: string;
  durationLabel: string;
  summaryCounts: PlanCountSource;
  summaryImportCount: number | null;
  planActionCount: number | null;
  planStatus: string;
  applyStatus: string;
  creatorUsername: string;
  creatorAvatarUrl: string;
  workspaceName: string;
  workspacePath: string;
  timestamps: Readonly<Record<string, string>>;
  inputStateSerial: string | undefined;
}>;

function RunTimeline({ timestamps, inputStateSerial }: Readonly<{
  timestamps: Readonly<Record<string, string>>;
  inputStateSerial: string | undefined;
}>): React.JSX.Element | null {
  // Insertion order is a serialization detail; the timeline reads oldest
  // first regardless of the order the API record lists the keys in.
  const timestampEntries = Object.entries(timestamps)
    .flatMap(([key, value]): ReadonlyArray<readonly [string, string, number]> => {
      const at = timestampMilliseconds(key, value);
      return at === undefined ? [] : [[key, value, at]];
    })
    .sort(([, , left], [, , right]): number => left - right);
  const isNumericSerial = inputStateSerial !== undefined && /^\d+$/.test(inputStateSerial);
  if (timestampEntries.length === 0 && !isNumericSerial) return null;
  return (
    <Disclosure label="Run timeline" className="rounded-none border-0 border-t" bodyClassName="px-5 py-4">
      <dl className="grid gap-3 text-xs">
        {timestampEntries.map(([key, value]): React.JSX.Element => (
          <div key={key}>
            <dt className="capitalize text-muted-foreground">{key.replace(/-at$/, "").replace(/-/g, " ")}</dt>
            <dd className="mt-0.5 text-foreground">{formatDate(value)}</dd>
          </div>
        ))}
        {inputStateSerial !== undefined && /^\d+$/.test(inputStateSerial) && (
          <div>
            <dt className="text-muted-foreground">Input state serial</dt>
            <dd className="mt-0.5 text-foreground" title="The workspace state snapshot used as this run's plan input.">
              #{inputStateSerial}
            </dd>
          </div>
        )}
      </dl>
    </Disclosure>
  );
}

export function RunDetailsCard(props: RunDetailsCardProps): React.JSX.Element {
  const { attributes, status } = props;
  const baseline = attributes["duration-baseline"];
  const medianSeconds = baseline?.["median-duration-seconds"];
  const slowRunNote = baseline?.["is-slow"] === true && isNumber(medianSeconds)
    ? (
      <span className="font-medium text-warning-text">
        Slower than typical (median {formatDurationSeconds(medianSeconds)})
      </span>
    )
    : null;

  return (
    <section aria-labelledby="run-details-heading" className="overflow-hidden rounded-lg border border-border bg-card">
      <h2 id="run-details-heading" className="border-b border-border px-5 py-4 text-sm font-semibold">Run details</h2>
      <MetaList
        columns={2}
        className="grid-cols-1 px-5 py-4 sm:grid-cols-1"
        items={[
          {
            label: props.durationLabel,
            value: props.duration,
            ...(slowRunNote === null ? {} : { note: slowRunNote }),
          },
          {
            label: "Resources changed",
            value: (
              <ResourceCounts
                additions={props.summaryCounts["resource-additions"]}
                changes={props.summaryCounts["resource-changes"]}
                destructions={props.summaryCounts["resource-destructions"]}
                imports={props.summaryImportCount}
                status={props.applyStatus === "finished" ? props.applyStatus : props.planStatus}
              />
            ),
          },
          {
            label: "Actions",
            value: props.planActionCount === null
              ? "Unavailable"
              : `${props.planActionCount} ${props.applyStatus === "finished" ? "invoked" : "to invoke"}`,
          },
          { label: "Status", value: formatRunStatus(status) },
          ...(props.creatorUsername === "" ? [] : [{
            label: "Created by",
            value: (
              <span className="flex items-center gap-2">
                <Avatar className="size-6 rounded-full">
                  {props.creatorAvatarUrl !== "" ? (
                    <AvatarImage src={props.creatorAvatarUrl} alt={props.creatorUsername} className="rounded-full object-cover" />
                  ) : (
                    <AvatarFallback className="rounded-full bg-muted text-2xs text-muted-foreground">
                      {props.creatorUsername.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  )}
                </Avatar>
                {props.creatorUsername}
              </span>
            ),
          }]),
          {
            label: "Workspace",
            value: (
              <Link to={props.workspacePath} className="break-all text-primary hover:underline">
                {props.workspaceName}
              </Link>
            ),
          },
          { label: "Operation", value: formatRunStatus(attributes.operation ?? "plan_and_apply") },
          { label: "Auto apply", value: attributes["auto-apply"] === true ? "Enabled" : "Disabled" },
          { label: "Engine version", value: attributes["terraform-version"] ?? "Workspace default" },
        ]}
      />
      <RunTimeline timestamps={props.timestamps} inputStateSerial={props.inputStateSerial} />
    </section>
  );
}
