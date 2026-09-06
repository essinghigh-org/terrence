export type DatabaseConstraint = "unique" | "foreign-key";

/** Inspect driver codes through ORM wrappers without exposing SQL or values. */
export function databaseConstraint(error: unknown): DatabaseConstraint | null {
  let current = error;
  const visited = new Set<unknown>();
  while (current !== null && typeof current === "object" && !visited.has(current) && visited.size < 8) {
    visited.add(current);
    const record = current as Readonly<Record<string, unknown>>;
    const code = record["code"] === "ERR_POSTGRES_SERVER_ERROR" ? record["errno"] : record["code"];
    if (code === "23505" || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") return "unique";
    if (code === "23503" || code === "SQLITE_CONSTRAINT_FOREIGNKEY") return "foreign-key";
    current = record["cause"];
  }
  return null;
}
