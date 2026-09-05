/**
 * Run-history list query builder (issue #591). The list paginates
 * server-side and searches the whole history through `search[basic]`
 * (ID, message, status, creator, source) instead of the loaded subset.
 * Kept here so the parameter contract is unit-testable: jsdom cannot drive
 * React 19 controlled inputs in this repo's harness, so the filter box
 * itself is only exercised in browser E2E.
 */
export function runHistoryPageUrl(
  workspaceId: string,
  page: number | null,
  sort: string,
  search: string,
): string {
  const url = new URL(`/api/v2/workspaces/${workspaceId}/runs`, "http://terrence.local");
  if (page !== null && page > 1) url.searchParams.set("page[number]", String(page));
  if (sort !== "") url.searchParams.set("sort", sort);
  const trimmedSearch = search.trim();
  if (trimmedSearch !== "") url.searchParams.set("search[basic]", trimmedSearch);
  return `${url.pathname}${url.search}`;
}
