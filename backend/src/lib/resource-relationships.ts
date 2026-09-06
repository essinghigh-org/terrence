/** JSON:API relationship input parsing. */

function isJsonApiData(item: unknown, expectedType: string): item is { readonly id: string; readonly type: string } {
  if (item === null || typeof item !== "object") return false;
  const candidate = item as Record<string, unknown>;
  return candidate["type"] === expectedType && typeof candidate["id"] === "string" && candidate["id"] !== "";
}

function relationshipIds(body: unknown, expectedType: string): string[] | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.["data"];
  if (!Array.isArray(data)) return undefined;
  if (data.some((item: unknown): boolean => !isJsonApiData(item, expectedType))) return undefined;
  // JSON:API accepts an explicit empty array as a no-op relationship update.
  return [...new Set(data.map((item: unknown): string => (item as { readonly id: string }).id))];
}

export function workspaceRelationshipIds(body: unknown): string[] | undefined {
  return relationshipIds(body, "workspaces");
}

export function stackRelationshipIds(body: unknown): string[] | undefined {
  return relationshipIds(body, "stacks");
}

export function projectRelationshipIds(body: unknown): string[] | undefined {
  return relationshipIds(body, "projects");
}

export type VarRelationshipResult = { many: boolean; resources: unknown[] };

export function variableRelationshipResources(body: unknown): VarRelationshipResult | undefined {
  const payload = body as Record<string, unknown> | null;
  const data = payload?.["data"];
  if (data === undefined || data === null) return undefined;
  const many = Array.isArray(data);
  const resources = many ? data as unknown[] : [data];
  if (
    resources.length > 0 &&
    (resources.some((item: unknown): boolean => !isJsonApiData(item, "vars"))
      || new Set(resources.map((item: unknown): string => (item as { readonly id: string }).id)).size !== resources.length)
  ) return undefined;
  return { many, resources };
}
