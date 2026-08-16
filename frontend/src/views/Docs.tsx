import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { fetchApi } from "../lib/api";
import { PageHeader, PageShell } from "../components/PageHeader";
import { MarkdownContent } from "../components/MarkdownContent";
import { Spinner } from "../components/ui/spinner";
import { BookOpen, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
import { isRecord, isString } from "../lib/type-guards";

type DocSummary = Readonly<{
  slug: string;
  title: string;
  category: string;
  order: number;
  description: string;
}>;

type DocDetail = DocSummary & Readonly<{ markdown: string }>;

function parseDocAttributes(value: unknown): DocSummary | null {
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

export function Docs(): React.JSX.Element {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const [index, setIndex] = useState<DocSummary[] | null>(null);
  const [details, setDetails] = useState<Map<string, DocDetail>>(new Map());
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchApi<{ data?: unknown }>("/docs").then((result) => {
      if (cancelled) return;
      if (!isRecord(result) || !Array.isArray(result["data"])) {
        setError(true);
        return;
      }
      const parsed = result["data"]
        .map((item): DocSummary | null => {
          if (!isRecord(item)) return null;
          return parseDocAttributes(item["attributes"]);
        })
        .filter((item): item is DocSummary => item !== null);
      setIndex(parsed);
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedSlug = slug ?? index?.[0]?.slug;
  const selected = selectedSlug === undefined ? undefined : details.get(selectedSlug);

  useEffect(() => {
    // A failed detail fetch (unknown slug, network error) must not stick:
    // navigating to another slug clears the error and retries.
    setError(false);
    if (selectedSlug === undefined || details.has(selectedSlug)) return;
    let cancelled = false;
    void fetchApi<{ data?: unknown }>(`/docs/${encodeURIComponent(selectedSlug)}`).then((result) => {
      if (cancelled) return;
      if (!isRecord(result) || !isRecord(result["data"]) || !isRecord(result["data"]["attributes"])) {
        setError(true);
        return;
      }
      const parsed = parseDocAttributes(result["data"]["attributes"]);
      const markdown = result["data"]["attributes"]["markdown"];
      if (parsed === null || !isString(markdown)) {
        setError(true);
        return;
      }
      setDetails((previous) => new Map(previous).set(selectedSlug, { ...parsed, markdown }));
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug, details]);

  const grouped = useMemo((): Array<{ category: string; docs: DocSummary[] }> => {
    const categories: Array<{ category: string; docs: DocSummary[] }> = [];
    for (const doc of index ?? []) {
      const existing = categories.find((group): boolean => group.category === doc.category);
      if (existing === undefined) categories.push({ category: doc.category, docs: [doc] });
      else existing.docs.push(doc);
    }
    return categories;
  }, [index]);

  if (error) {
    return (
      <PageShell>
        <PageHeader title="Documentation" description="The documentation index could not be loaded." />
        <p className="text-sm text-muted-foreground">Check that the documentation bundle is present in the deployment, then reload.</p>
      </PageShell>
    );
  }

  if (index === null) {
    return (
      <PageShell>
        <PageHeader title="Documentation" description="Loading documentation." />
        <div className="flex justify-center py-16"><Spinner className="size-6" /></div>
      </PageShell>
    );
  }

  const sidebar = (
    <nav aria-label="Documentation index" className="space-y-5">
      {grouped.map((group): React.JSX.Element => (
        <div key={group.category}>
          <div className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.category}</div>
          <ul className="space-y-0.5">
            {group.docs.map((doc): React.JSX.Element => {
              const active = doc.slug === selectedSlug;
              return (
                <li key={doc.slug}>
                  <button
                    type="button"
                    onClick={(): void => {
                      navigate(`/app/docs/${doc.slug}`);
                    }}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", active && "rotate-90 text-primary")} />
                    {doc.title}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <PageShell>
      <div className="flex gap-8">
        {/* Desktop index */}
        <aside className="hidden w-64 shrink-0 lg:block">
          <div className="sticky top-20 max-h-[calc(100vh-7rem)] overflow-y-auto pb-8">{sidebar}</div>
        </aside>
        {/* Mobile index */}
        <details className="group w-full lg:hidden">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-muted-foreground">
            <BookOpen className="size-4" />
            {selected?.title ?? "Documentation"}
            <ChevronRight className="ml-auto size-4 transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-3">{sidebar}</div>
        </details>
        {/* Content */}
        <article className="min-w-0 flex-1 pb-16">
          {selected === undefined ? (
            <div className="flex justify-center py-16"><Spinner className="size-6" /></div>
          ) : (
            <>
              <PageHeader title={selected.title} description={selected.description} />
              <div
                className="max-w-3xl"
                onClick={(event): void => {
                  // Doc-to-doc links are relative ("runs" or "./runs"); route
                  // them through the SPA instead of a full page reload.
                  const target = event.target as HTMLElement | null;
                  const anchor = target?.closest("a");
                  const href = anchor?.getAttribute("href");
                  if (anchor === null || anchor === undefined || href === null || href === undefined) return;
                  // Only bare-relative and docs-prefixed links are doc links.
                  // Links with a scheme (https:, mailto:) and fragment links
                  // keep their default behavior.
                  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith("#")) return;
                  event.preventDefault();
                  const slug = href.replace(/^\.\//, "").replace(/^\/app\/docs\//, "");
                  void navigate(`/app/docs/${encodeURIComponent(slug)}`);
                }}
              >
                <MarkdownContent markdown={selected.markdown} />
              </div>
            </>
          )}
        </article>
      </div>
    </PageShell>
  );
}