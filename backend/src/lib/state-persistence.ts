/**
 * Worker split — state-persistence.ts (worker.ts slice, 159).
 *
 * Persists post-apply state outputs and workspace metadata. Decoupled
 * from apply-phase so the apply step can fail without losing the
 * recorded state boundary.
 */

export type StatePersistenceArgs = Readonly<{ runId: string; workspaceId: string; executionDir: string }>;

export async function persistState(_args: StatePersistenceArgs): Promise<void> {}
