export const RUN_ID_LENGTH = 18;

export function newRunId(): string {
  return `run-${crypto.randomUUID().replace(/-/g, "").slice(0, RUN_ID_LENGTH - "run-".length)}`;
}
