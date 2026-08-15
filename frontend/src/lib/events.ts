import { ApiError, prepareAuthToken } from "./api";
import { isRecord } from "../lib/type-guards";

export type RunStatusEvent = Readonly<{
  "run-id": string;
  "workspace-id": string;
  "org-id": string | null;
  status: string;
  at: string;
}>;

export type SseEvent = Readonly<{
  name: string;
  data: Readonly<Record<string, unknown>>;
}>;

export type EventStreamHandle = Readonly<{ close: () => void }>;

/**
 * Authenticated Server-Sent Events subscription (10.20). Connects to
 * /api/v2/events with the in-memory bearer token, parses `event:`/`data:`
 * frames, and reconnects with exponential backoff (1s..30s) after drops.
 * Closing the handle or aborting the signal stops the loop.
 */
export function subscribeEvents(
  onEvent: (event: SseEvent) => void,
  signal?: Readonly<AbortSignal>,
): EventStreamHandle {
  const controller = new AbortController();
  let closed = false;
  let retryMs = 1000;
  let timer: number | undefined;

  const close = (): void => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", outerAbort);
    if (timer !== undefined) window.clearTimeout(timer);
    controller.abort();
  };

  const outerAbort = (): void => { close(); };
  if (signal?.aborted === true) {
    // The caller's signal was already aborted: never open or reconnect.
    closed = true;
    controller.abort();
    return { close };
  }
  signal?.addEventListener("abort", outerAbort, { once: true });

  const open = async (): Promise<void> => {
    if (closed || controller.signal.aborted) return;
    let token: string | null = null;
    try {
      token = await prepareAuthToken();
    } catch {
      token = null;
    }
    if (closed || controller.signal.aborted) return;
    try {
      const response = await fetch("/api/v2/events", {
        headers: token !== null && token !== "" ? { Authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      });
      if (closed) return;
      if (response.status === 401 || response.status === 403) {
        // Authentication failures are terminal: retrying cannot help and
        // would only spin against a revoked session.
        close();
        return;
      }
      if (!response.ok) throw new ApiError(response.status, `Event stream failed (${response.status})`);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Event stream had no body");
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Split on both LF and CRLF frame separators.
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (frame.trim() === "") continue;
          const event = parseEventFrame(frame);
          if (event !== null) {
            // Backoff resets only once the stream has demonstrated health
            // by delivering frames; a connect that drops instantly must
            // keep backing off.
            retryMs = 1000;
            onEvent(event);
          }
        }
      }
    } catch {
      // Stream ended or failed; reconnect below unless the caller closed.
    }
    if (!closed && !controller.signal.aborted) {
      timer = window.setTimeout((): void => { void open(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    }
  };

  void open();
  return { close };
}

function parseEventFrame(frame: string): SseEvent | null {
  let name = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    // SAFETY: the parsed payload is validated field-by-field by the caller.
    const parsed = JSON.parse(raw) as unknown;
    // SAFETY: the typeof-object guard is the boundary check; the data field
    // is consumed as a record of string-typed values by the event handlers.
    const data = isRecord(parsed) ? parsed as Record<string, unknown> : {};
    return {
      name,
      data,
    };
  } catch {
    return null;
  }
}