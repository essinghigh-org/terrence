/** Pagination parsing and response metadata. */
import type { RequestWithUrl } from "./types";

export function pageRequest(request: RequestWithUrl): { number: number; size: number } {
  const params = new URL(request.url).searchParams;
  const number = Number.parseInt(params.get("page[number]") ?? "1", 10);
  const size = Number.parseInt(params.get("page[size]") ?? "20", 10);
  return {
    number: Number.isSafeInteger(number) && number > 0 ? number : 1,
    size: Number.isSafeInteger(size) && size > 0 ? Math.min(size, 100) : 20,
  };
}

/** Cursor pagination (303-305): keyset helper for enormous tables. */
export function cursorPagination(
  request: RequestWithUrl,
  cursor: string | null,
  pageSize: number,
  hasMore: boolean,
): { links: Record<string, string | null>; meta: Record<string, unknown> } {
  const nextCursor = hasMore ? cursor : null;
  const base = new URL(request.url);
  const linkFor = (value: string | null): string | null => {
    if (value === null) return null;
    const url = new URL(base.toString());
    url.searchParams.set("page[cursor]", value);
    url.searchParams.set("page[size]", String(pageSize));
    return url.toString();
  };
  return {
    links: { self: request.url, first: linkFor(null), prev: null, next: linkFor(nextCursor), last: null },
    meta: { pagination: { "page-size": pageSize, "next-cursor": nextCursor, cursor } },
  };
}

export function pagination(
  request: RequestWithUrl,
  currentPage: number,
  pageSize: number,
  totalCount: number,
): { links: Record<string, string | null>; meta: Record<string, unknown> } {
  // Empty collections still expose page 1 through first/last links. Keep the
  // metadata consistent with those links instead of reporting zero pages.
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const pageLink = (page: number): string => {
    const url = new URL(request.url);
    url.searchParams.set("page[number]", String(page));
    url.searchParams.set("page[size]", String(pageSize));
    return url.toString();
  };

  return {
    links: {
      self: request.url,
      first: pageLink(1),
      prev: currentPage > 1 ? pageLink(currentPage - 1) : null,
      next: currentPage < totalPages ? pageLink(currentPage + 1) : null,
      last: pageLink(Math.max(1, totalPages)),
    },
    meta: {
      pagination: {
        "current-page": currentPage,
        "page-size": pageSize,
        "prev-page": currentPage > 1 ? currentPage - 1 : null,
        "next-page": currentPage < totalPages ? currentPage + 1 : null,
        "total-pages": totalPages,
        "total-count": totalCount,
      },
    },
  };
}

export type { RequestWithUrl } from "./types";
