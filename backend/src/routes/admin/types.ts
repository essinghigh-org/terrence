import type { users } from "../../db/schema";

export type SetObj = Readonly<{ status?: number | string; headers: Readonly<Record<string, string | number>> }>;

export type ParamCtx = Readonly<{
  readonly params: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly user?: Readonly<typeof users.$inferSelect> | null;
  readonly token?: Readonly<{ id: string }> | null;
  readonly request: Readonly<{ url: string }>;
  readonly set: SetObj;
}>;
