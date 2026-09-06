export type BoundedProcessOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  discardStdout?: boolean;
  stdoutLimitMessage?: string;
}>;

/** Drain both pipes concurrently; terminate and reap on cancellation or overflow. */
export async function runBoundedProcess(
  command: readonly string[],
  options: BoundedProcessOptions = {},
): Promise<Readonly<{ stdout: string; stderr: string }>> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  signal.throwIfAborted();
  const child = Bun.spawn([...command], {
    env: { ...process.env, LC_ALL: "C", TAR_OPTIONS: undefined },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  let failure: Error | undefined;
  const stop = (error: unknown): void => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    child.kill("SIGKILL");
    void stdoutReader.cancel().catch(() => { /* Cancellation may race with pipe closure. */ });
    void stderrReader.cancel().catch(() => { /* Cancellation may race with pipe closure. */ });
  };
  const abort = (): void => { stop(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // The stream reader advances its cursor; it cannot be deeply readonly.
  const drain = async (
    // eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types
    reader: Readonly<ReadableStreamDefaultReader<Uint8Array>>,
    limit: number,
    discard: boolean,
    limitMessage?: string,
  ): Promise<string> => {
    let bytes = 0;
    let output = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > limit) throw new Error(limitMessage ?? `Process output exceeds the ${limit} byte limit`);
        if (!discard) output += decoder.decode(next.value, { stream: true });
      }
      return discard ? "" : output + decoder.decode();
    } catch (error) {
      stop(error);
      return "";
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      drain(stdoutReader, options.maxStdoutBytes ?? 4 * 1024 * 1024, options.discardStdout ?? false, options.stdoutLimitMessage),
      drain(stderrReader, options.maxStderrBytes ?? 64 * 1024, false),
    ]);
    if (failure !== undefined) throw failure;
    if (exitCode !== 0) throw new Error(stderr.trim() || `Process exited with status ${exitCode}`);
    return { stdout, stderr };
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
