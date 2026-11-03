export type Binding = { id: string; key: string; value: string };

export function parseBindings(
  body: unknown,
  kind: "modules" | "providers" | "components",
): { key: string; value: string }[] | undefined {
  const data = (body as { data?: { type?: unknown; relationships?: { "tag-bindings"?: { data?: unknown } } } } | null)
    ?.data;
  if (data?.type !== `registry-${kind}`) return undefined;
  const tags = data.relationships?.["tag-bindings"]?.data;
  if (!Array.isArray(tags)) return undefined;
  const seen = new Set<string>();
  const result: { key: string; value: string }[] = [];
  for (const raw of tags as unknown[]) {
    const tag = parseBinding(raw);
    if (!tag || seen.has(tag.key)) return undefined;
    seen.add(tag.key);
    result.push(tag);
  }
  return result;
}

function parseBinding(raw: unknown): { key: string; value: string } | undefined {
  const tag = raw as { type?: unknown; attributes?: { key?: unknown; value?: unknown } } | null;
  const key = tag?.attributes?.key;
  // go-tfe omits empty values when serializing tag bindings.
  const value = tag?.attributes?.value === undefined ? "" : tag.attributes.value;
  if (tag?.type !== "tag-bindings" || typeof key !== "string" || key.trim() === "" || typeof value !== "string")
    return undefined;
  return { key, value };
}

export function replaceBindings(existing: string, input: readonly Readonly<{ key: string; value: string }>[]): string {
  const previous = JSON.parse(existing) as Binding[];
  return JSON.stringify(
    input.map(({ key, value }) => ({
      id: previous.find((tag) => tag.key === key)?.id ?? `tagb-${crypto.randomUUID()}`,
      key,
      value,
    })),
  );
}
