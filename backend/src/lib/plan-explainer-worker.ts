import { getSettings, resolvePlanExplainerSettings } from "./settings";
import { buildExplainSource, fetchUpstream, parseCompletionBody, saveExplanation, type ExplainKind } from "./run-explanations";
import type { DurableJob, DurableJobContext } from "./durable-jobs";
import { log } from "./log";

export async function runPlanExplanationJob(job: DurableJob, context: DurableJobContext): Promise<void> {
  const payload = job.payload as { runId?: string; kind?: string };
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const kind = payload.kind as ExplainKind;
  if (runId === "" || (kind !== "plan" && kind !== "apply")) {
    throw new Error(`Invalid plan-explainer job payload: ${JSON.stringify(payload)}`);
  }
  if (await context.canceled()) return;
  await context.heartbeat();

  const settings = await getSettings("plan-explainer");
  if (settings["enabled"] !== true) {
    throw new Error("Plan explainer is disabled");
  }
  const resolved = await resolvePlanExplainerSettings(settings);
  if (resolved === null) {
    throw new Error("Plan explainer is not fully configured");
  }
  await context.heartbeat();
  if (await context.canceled()) return;

  const source = await buildExplainSource(runId, kind);
  if (source === undefined) {
    throw new Error(kind === "plan" ? "No plan JSON is available for this run" : "No apply log is available for this run");
  }
  await context.heartbeat();
  if (await context.canceled()) return;

  const model = resolved["model"] as string;

  let content: string;
  const parts = await fetchUpstream(resolved, source.prompt, false, undefined, async (upstream, tick) => {
    tick();
    await context.heartbeat();
    if (await context.canceled()) throw new Error("Job canceled");
    if (!upstream.ok) throw new Error(`Plan explainer endpoint returned ${upstream.status}`);
    let parsed: unknown;
    try {
      parsed = await upstream.json();
    } catch (error: unknown) {
      log.warn(`Plan explainer returned unparseable body for run ${runId}: ${String(error)}`);
      throw new Error("Plan explainer returned an unparseable response");
    }
    const completion = parseCompletionBody(parsed);
    if (completion.content === "") throw new Error("Plan explainer returned no explanation");
    tick();
    await context.heartbeat();
    return completion;
  });
  content = parts.content;

  if (await context.canceled()) return;
  await saveExplanation(runId, kind, model, content);
}
