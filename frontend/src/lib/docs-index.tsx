import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { fetchApi } from "./api";
import { isRecord, isString } from "./type-guards";

export type DocSummary = Readonly<{
  slug: string;
  title: string;
  category: string;
  order: number;
  description: string;
}>;

export function parseDocSummary(value: unknown): DocSummary | null {
  if (!isRecord(value)) return null;
  const slug = value["slug"];
  const title = value["title"];
  const category = value["category"];
  const order = value["order"];
  const description = value["description"];
  if (!isString(slug) || !isString(title) || !isString(category) || !isString(description)) return null;
  if (typeof order !== "number") return null;
  return { slug, title, category, order, description };
}

export function groupDocsByCategory(docs: DocSummary[]): Array<{ category: string; docs: DocSummary[] }> {
  const groups: Array<{ category: string; docs: DocSummary[] }> = [];
  for (const doc of docs) {
    const existing = groups.find((group): boolean => group.category === doc.category);
    if (existing === undefined) groups.push({ category: doc.category, docs: [doc] });
    else existing.docs.push(doc);
  }
  return groups;
}

type DocsIndexState = Readonly<{
  index: DocSummary[] | null;
  error: boolean;
}>;

const DEFAULT_STATE: DocsIndexState = { index: null, error: false };

const DocsIndexContext = createContext<DocsIndexState>(DEFAULT_STATE);

/**
 * Loads the documentation index once per app session and shares it between
 * the sidebar navigation and the documentation view. Mounted above Layout,
 * so a single /docs fetch serves every consumer.
 */
export function DocsIndexProvider({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [state, setState] = useState<DocsIndexState>(DEFAULT_STATE);

  useEffect(() => {
    let cancelled = false;
    void fetchApi<{ data?: unknown }>("/docs")
      .then((result): void => {
        if (cancelled) return;
        if (!isRecord(result) || !Array.isArray(result["data"])) {
          setState({ index: null, error: true });
          return;
        }
        const parsed = result["data"]
          .map((item): DocSummary | null => (isRecord(item) ? parseDocSummary(item["attributes"]) : null))
          .filter((item): item is DocSummary => item !== null);
        setState({ index: parsed, error: false });
      })
      .catch((): void => {
        if (!cancelled) setState({ index: null, error: true });
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  return <DocsIndexContext.Provider value={state}>{children}</DocsIndexContext.Provider>;
}

/**
 * Falls back to an empty state when no provider is mounted so components
 * render safely in isolation (tests, storybook-style usage).
 */
export function useDocsIndex(): DocsIndexState {
  return useContext(DocsIndexContext);
}
