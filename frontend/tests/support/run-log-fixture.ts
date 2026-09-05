/**
 * Fixtures for the run page's phase logs.
 *
 * The run page reads phase logs from the raw log endpoints
 * (`/runs/:id/plan/log`, `/runs/:id/apply/log`) over the byte-offset protocol,
 * not from the paged `/runs/:id/logs` JSON:API collection. Tests that used to
 * stub the collection with phase-tagged rows go through here instead, so the
 * offset and total-bytes headers a tail depends on are always well-formed.
 */

const encoder = new TextEncoder();

/** Serve `body` as a phase log, honouring an `offset` query parameter. */
export function phaseLogResponse(body: string, url: string): Response {
  const bytes = encoder.encode(body);
  const parsed = new URL(url, "http://terrence.local");
  const rawOffset = Number.parseInt(parsed.searchParams.get("offset") ?? "0", 10);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return new Response(bytes.slice(offset), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Terrence-Log-Total-Bytes": String(bytes.byteLength),
      "X-Terrence-Log-Truncated": "false",
    },
  });
}

/**
 * Serve an empty phase log for any run.
 *
 * For the many tests whose subject is not the log pane: they can satisfy the
 * page's two log reads without naming a run id, instead of falling through to
 * an "unexpected request" throw.
 */
export function anyPhaseLog(url: string): Response | null {
  const path = new URL(url, "http://terrence.local").pathname;
  return /\/api\/v2\/runs\/[^/]+\/(plan|apply)\/log$/.test(path)
    ? phaseLogResponse("", url)
    : null;
}

/**
 * Handle both phase log endpoints for one run, or return null so the caller's
 * mock can fall through to its other routes.
 */
export function handlePhaseLogs(
  url: string,
  runId: string,
  logs: Readonly<{ plan?: string; apply?: string }>,
): Response | null {
  const path = new URL(url, "http://terrence.local").pathname;
  if (path === `/api/v2/runs/${runId}/plan/log`) {
    return phaseLogResponse(logs.plan ?? "", url);
  }
  if (path === `/api/v2/runs/${runId}/apply/log`) {
    return phaseLogResponse(logs.apply ?? "", url);
  }
  return null;
}
