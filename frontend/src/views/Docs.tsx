import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { fetchApi } from "../lib/api";
import { groupDocsByCategory, parseDocSummary, useDocsIndex, type DocSummary } from "../lib/docs-index";
import { PageHeader, PageShell } from "../components/PageHeader";
import { MarkdownContent } from "../components/MarkdownContent";
import { Spinner } from "../components/ui/spinner";
import { isRecord, isString } from "../lib/type-guards";

type DocDetail = DocSummary & Readonly<{ markdown: string }>;

function parseDocDetail(value: unknown): DocDetail | null {
  if (!isRecord(value) || !isRecord(value["data"]) || !isRecord(value["data"]["attributes"])) return null;
  const attributes = value["data"]["attributes"];
  const summary = parseDocSummary(attributes);
  const markdown = attributes["markdown"];
  if (summary === null || !isString(markdown)) return null;
  return { ...summary, markdown };
}

export function Docs(): React.JSX.Element {
  const navigate = useNavigate();
  const { slug } = useParams<{ slug: string }>();
  const docs = useDocsIndex();
  const [details, setDetails] = useState<Map<string, DocDetail>>(new Map());
  const [detailError, setDetailError] = useState(false);

  const index = docs.index;
  // No slug in the URL (index route) shows the first document of the index,
  // matching the highlight in the sidebar.
  const selectedSlug = slug ?? index?.[0]?.slug;
  const selected = selectedSlug === undefined ? undefined : details.get(selectedSlug);

  useEffect((): (() => void) | undefined => {
    // A failed detail fetch (unknown slug, network error) must not stick:
    // navigating to another slug clears the error and retries.
    setDetailError(false);
    if (selectedSlug === undefined || details.has(selectedSlug)) return;
    let cancelled = false;
    void fetchApi<{ data?: unknown }>(`/docs/${encodeURIComponent(selectedSlug)}`).then((result): void => {
      if (cancelled) return;
      const parsed = parseDocDetail(result);
      if (parsed === null) {
        setDetailError(true);
        return;
      }
      setDetails((previous): Map<string, DocDetail> => new Map(previous).set(selectedSlug, parsed));
    }).catch((): void => {
      if (!cancelled) setDetailError(true);
    });
    return (): void => {
      cancelled = true;
    };
  }, [selectedSlug, details]);

  const groups = useMemo((): ReturnType<typeof groupDocsByCategory> => groupDocsByCategory(index ?? []), [index]);

  const { previous, next } = useMemo((): { previous: DocSummary | undefined; next: DocSummary | undefined } => {
    if (selected === undefined) return { previous: undefined, next: undefined };
    const group = groups.find((entry): boolean => entry.category === selected.category);
    if (group === undefined) return { previous: undefined, next: undefined };
    const position = group.docs.findIndex((doc): boolean => doc.slug === selected.slug);
    return {
      previous: position > 0 ? group.docs[position - 1] : undefined,
      next: position >= 0 && position < group.docs.length - 1 ? group.docs[position + 1] : undefined,
    };
  }, [groups, selected]);

  if (docs.error || detailError) {
    return (
      <PageShell>
        <PageHeader title="Documentation" description="The documentation could not be loaded." />
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

  return (
    <PageShell>
      <PageHeader
        title={selected?.title ?? "Documentation"}
        description={selected?.description ?? "Loading documentation."}
      />
      {selected === undefined ? (
        <div className="flex justify-center py-16"><Spinner className="size-6" /></div>
      ) : (
        <>
          <div
            className="max-w-4xl"
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
              const targetSlug = href.replace(/^\.\//, "").replace(/^\/app\/docs\//, "");
              void navigate(`/app/docs/${encodeURIComponent(targetSlug)}`);
            }}
          >
            <MarkdownContent markdown={selected.markdown} />
          </div>
          {(previous !== undefined || next !== undefined) && (
            <nav
              aria-label="Document navigation"
              className="mt-10 grid gap-3 border-t border-border pt-6 sm:grid-cols-2"
            >
              {previous !== undefined ? (
                <Link
                  to={`/app/docs/${encodeURIComponent(previous.slug)}`}
                  className="group rounded-lg border border-border p-4 outline-none transition-colors hover:border-primary/40 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <ArrowLeft aria-hidden="true" className="size-3.5" />
                    Previous
                  </div>
                  <div className="mt-1 truncate text-sm font-medium text-foreground">{previous.title}</div>
                </Link>
              ) : (
                <div className="hidden sm:block" aria-hidden="true" />
              )}
              {next !== undefined ? (
                <Link
                  to={`/app/docs/${encodeURIComponent(next.slug)}`}
                  className="group rounded-lg border border-border p-4 text-right outline-none transition-colors hover:border-primary/40 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-center justify-end gap-1.5 text-xs font-medium text-muted-foreground">
                    Next
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                  </div>
                  <div className="mt-1 truncate text-sm font-medium text-foreground">{next.title}</div>
                </Link>
              ) : null}
            </nav>
          )}
        </>
      )}
    </PageShell>
  );
}
