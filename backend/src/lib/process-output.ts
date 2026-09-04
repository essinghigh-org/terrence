import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, rename } from "node:fs/promises";
import { join } from "node:path";

/** Maximum amount of process output retained in orchestration diagnostics. */
export const PROCESS_OUTPUT_PREVIEW_CHARS = 16 * 1024;

type ProcessStream = Readonly<ReadableStream<Uint8Array>> | undefined;

export type CapturedProcessStream = Readonly<{
  path: string;
  bytes: number;
  preview: string;
  truncated: boolean;
}>;

export type CapturedProcessOutput = Readonly<{
  stdout: CapturedProcessStream;
  stderr: CapturedProcessStream;
}>;

export type ProcessOutputPart = string | Readonly<{ path: string }>;

function safePrefix(prefix: string): string {
  const normalized = prefix.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^\.+/, "");
  return normalized === "" ? "process" : normalized;
}

function normalizedCaptureError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "Process output capture failed");
}

async function captureStream(stream: ProcessStream, path: string): Promise<CapturedProcessStream> {
  const writer = Bun.file(path).writer();
  const reader = stream?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let preview = "";
  let truncated = false;

  const appendPreview = (text: string): void => {
    if (text === "") return;
    const remaining = PROCESS_OUTPUT_PREVIEW_CHARS - preview.length;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    preview += text.slice(0, remaining);
    if (text.length > remaining) truncated = true;
  };

  try {
    if (reader !== undefined) {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        await writer.write(next.value);
        bytes += next.value.byteLength;
        appendPreview(decoder.decode(next.value, { stream: true }));
      }
      appendPreview(decoder.decode());
    }
    await writer.end();
    await chmod(path, 0o600);
    return { path, bytes, preview, truncated };
  } catch (error: unknown) {
    try { await writer.end(); } catch { /* already closed */ }
    await rm(path, { force: true });
    throw error;
  } finally {
    reader?.releaseLock();
  }
}

/** Drain both child streams to private files while retaining only bounded previews. */
export async function captureProcessOutput(
  stdout: ProcessStream,
  stderr: ProcessStream,
  outputDirectory: string,
  prefix: string,
): Promise<CapturedProcessOutput> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const base = `${safePrefix(prefix)}-${randomUUID()}`;
  const stdoutPath = join(outputDirectory, `${base}.stdout`);
  const stderrPath = join(outputDirectory, `${base}.stderr`);
  const [stdoutResult, stderrResult] = await Promise.allSettled([
    captureStream(stdout, stdoutPath),
    captureStream(stderr, stderrPath),
  ]);
  if (stdoutResult.status === "rejected" || stderrResult.status === "rejected") {
    await Promise.allSettled([
      rm(stdoutPath, { force: true }),
      rm(stderrPath, { force: true }),
    ]);
    const failure = stdoutResult.status === "rejected"
      ? normalizedCaptureError(stdoutResult.reason as unknown)
      : stderrResult.status === "rejected"
        ? normalizedCaptureError(stderrResult.reason as unknown)
        : new Error("Process output capture failed");
    throw failure;
  }
  return { stdout: stdoutResult.value, stderr: stderrResult.value };
}

/** Return the bounded diagnostic form used in errors and status records. */
export function processOutputPreview(output: CapturedProcessOutput): string {
  const parts = [output.stdout.preview.trim(), output.stderr.preview.trim()].filter(Boolean);
  const preview = parts.join("\n");
  if (!output.stdout.truncated && !output.stderr.truncated) return preview;
  const marker = `[terrence] Process output truncated after ${String(PROCESS_OUTPUT_PREVIEW_CHARS)} characters per stream.`;
  return preview === "" ? marker : `${preview}\n${marker}`;
}

export function processOutputBytes(output: CapturedProcessOutput): number {
  return output.stdout.bytes + output.stderr.bytes;
}

/** Compose private process-output files without materializing them in JavaScript. */
export async function writeProcessOutputFile(
  target: string,
  parts: readonly ProcessOutputPart[],
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  const writer = Bun.file(temporary).writer();
  let published = false;
  try {
    for (const part of parts) {
      if (typeof part === "string") {
        if (part !== "") await writer.write(part);
        continue;
      }
      const reader = Bun.file(part.path).stream().getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          await writer.write(next.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    await writer.end();
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    published = true;
  } finally {
    try { await writer.end(); } catch { /* already closed */ }
    await rm(temporary, { force: true });
  }
  if (!published) throw new Error("Process output artifact was not published");
}
