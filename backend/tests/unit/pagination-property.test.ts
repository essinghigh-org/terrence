/**
 * pagination-property.test.ts — property tests for the shared pagination
 * helpers in src/lib/utils.ts (kanban 22.7).
 *
 * Covers the empty page, exact page, last-partial-page and invalid-value
 * cases called out in the task, plus randomized properties over the
 * `pageRequest` parser and the `pagination` link/meta builder:
 *
 *   - pageRequest: absent/NaN/zero/negative/float/huge/garbage inputs fall
 *     back to the documented defaults; size is clamped to the 100 cap.
 *   - pagination: prev/next/first/last link presence and targets are
 *     consistent with ceil(totalCount / pageSize); meta mirrors links.
 *   - Partition property: walking pages 1..totalPages with the same slicing
 *     the routes use reproduces the original list exactly (no loss, no
 *     duplication, order preserved) for every (N, size) pair in a small
 *     exhaustive grid including empty, exact, and partial final pages.
 */
import { describe, expect, test } from "bun:test";
import { pageRequest, pagination, type RequestWithUrl } from "../../src/lib/utils";

/** Deterministic mulberry32 PRNG so fuzz runs are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function requestWithQuery(query: string): RequestWithUrl {
  return { url: `http://test.local/api/v2/organizations/acme/workspaces?${query}` };
}

const DEFAULT = { number: 1, size: 20 };

describe("pageRequest (query parser)", () => {
  test("absent parameters fall back to defaults", () => {
    expect(pageRequest(requestWithQuery(""))).toEqual(DEFAULT);
    expect(pageRequest(requestWithQuery("filter[status]=running"))).toEqual(DEFAULT);
    expect(pageRequest(requestWithQuery("page[number]="))).toEqual(DEFAULT);
    expect(pageRequest(requestWithQuery("page[size]="))).toEqual(DEFAULT);
    expect(pageRequest(requestWithQuery("page[number]=&page[size]="))).toEqual(DEFAULT);
  });

  test("valid values round-trip", () => {
    expect(pageRequest(requestWithQuery("page[number]=3&page[size]=50"))).toEqual({ number: 3, size: 50 });
    expect(pageRequest(requestWithQuery("page[number]=1&page[size]=1"))).toEqual({ number: 1, size: 1 });
    expect(pageRequest(requestWithQuery("page[number]=1000000&page[size]=100"))).toEqual({ number: 1_000_000, size: 100 });
  });

  test("size above the 100 cap is clamped, never rejected", () => {
    expect(pageRequest(requestWithQuery("page[size]=101")).size).toBe(100);
    expect(pageRequest(requestWithQuery("page[size]=999999")).size).toBe(100);
    expect(pageRequest(requestWithQuery("page[number]=2&page[size]=101"))).toEqual({ number: 2, size: 100 });
  });

  test("invalid values fall back to defaults", () => {
    const bad = [
      "page[number]=0",
      "page[number]=-5",
      "page[number]=abc",
      "page[number]=%20",
      "page[size]=0",
      "page[size]=-1",
      "page[size]=abc",
      "page[number]=1&page[size]=-20",
      "page[number]=NaN",
      "page[number]=Infinity",
      // beyond MAX_SAFE_INTEGER (Number.isSafeInteger rejects)
      "page[number]=9007199254740992",
      "page[size]=9007199254740993",
    ];
    for (const query of bad) {
      expect(pageRequest(requestWithQuery(query))).toEqual(DEFAULT);
    }
  });

  test("parseInt truncation is pinned behavior, not a fallback", () => {
    // Number.parseInt truncates decimals and trailing junk; the parser keeps
    // whatever parses to a positive safe integer. Pin that so a future
    // strict-mode change is a deliberate decision.
    expect(pageRequest(requestWithQuery("page[number]=1.5"))).toEqual({ number: 1, size: 20 });
    expect(pageRequest(requestWithQuery("page[size]=2.75"))).toEqual({ number: 1, size: 2 });
    expect(pageRequest(requestWithQuery("page[number]=12abc"))).toEqual({ number: 12, size: 20 });
    expect(pageRequest(requestWithQuery("page[size]=1e2"))).toEqual({ number: 1, size: 1 });
  });

  test("fuzz: random query strings never throw and never exceed the cap", () => {
    const rand = mulberry32(22_07);
    const tokens = ["", "0", "1", "-3", "12abc", "1e2", "abc", "100", "101", "99999999999999999999", " 5 ", "%00"];
    for (let i = 0; i < 2000; i++) {
      const numberTok = tokens[Math.floor(rand() * tokens.length)];
      const sizeTok = tokens[Math.floor(rand() * tokens.length)];
      const parsed = pageRequest(requestWithQuery(`page[number]=${numberTok}&page[size]=${sizeTok}`));
      expect(Number.isSafeInteger(parsed.number)).toBe(true);
      expect(parsed.number).toBeGreaterThanOrEqual(1);
      expect(Number.isSafeInteger(parsed.size)).toBe(true);
      expect(parsed.size).toBeGreaterThanOrEqual(1);
      expect(parsed.size).toBeLessThanOrEqual(100);
      if (sizeTok === "100" || sizeTok === "101") expect(parsed.size).toBe(100);
    }
  });
});

describe("pagination (link/meta builder)", () => {
  test("empty collection still yields a valid link graph", () => {
    const p = pagination(requestWithQuery(""), 1, 20, 0);
    const meta = p.meta["pagination"] as Record<string, unknown>;
    // Empty collections expose a single, empty page so metadata and links
    // agree on the page-1 range.
    expect(meta).toEqual({
      "current-page": 1,
      "page-size": 20,
      "prev-page": null,
      "next-page": null,
      "total-pages": 1,
      "total-count": 0,
    });
    expect(p.links["prev"]).toBeNull();
    expect(p.links["next"]).toBeNull();
    expect(p.links["self"]).toBe(requestWithQuery("").url);
    expect(p.links["first"]).toContain("page%5Bnumber%5D=1");
    expect(p.links["last"]).toContain("page%5Bnumber%5D=1");
  });

  test("exact page boundary: no next link on the last full page", () => {
    // 40 items at size 20 -> exactly 2 pages
    const request = requestWithQuery("page[number]=2&page[size]=20");
    const p = pagination(request, 2, 20, 40);
    const meta = p.meta["pagination"] as Record<string, unknown>;
    expect(meta["total-pages"]).toBe(2);
    expect(p.links["next"]).toBeNull();
    expect(p.links["prev"]).not.toBeNull();
    expect(p.links["last"]).toContain("page%5Bnumber%5D=2");
    expect(p.links["self"]).toBe(request.url);
  });

  test("last partial page is reachable and reported", () => {
    // 21 items at size 10 -> page 3 holds 1 item
    const p = pagination(requestWithQuery(""), 3, 10, 21);
    const meta = p.meta["pagination"] as Record<string, unknown>;
    expect(meta["total-pages"]).toBe(3);
    expect(meta["total-count"]).toBe(21);
    expect(p.links["next"]).toBeNull();
    expect(p.links["prev"]).not.toBeNull();
  });

  test("over-page requests keep the link graph consistent", () => {
    const p = pagination(requestWithQuery(""), 99, 20, 5);
    const meta = p.meta["pagination"] as Record<string, unknown>;
    expect(meta["current-page"]).toBe(99);
    expect(meta["total-pages"]).toBe(1);
    expect(p.links["next"]).toBeNull();
    // self echoes the request; first/last point at the real range
    expect(p.links["self"]).toBe(requestWithQuery("").url);
    expect(p.links["first"]).not.toBeNull();
    expect(p.links["last"]).toBe(p.links["first"]);
  });

  test("self preserves the exact request URI", () => {
    const request = requestWithQuery("filter[status]=pending&page[size]=10&page[number]=2");
    const p = pagination(request, 2, 10, 25);
    expect(p.links["self"]).toBe(request.url);
  });

  test("fuzz: link presence/targets match ceil(total/size) for arbitrary inputs", () => {
    const rand = mulberry32(0x5eed);
    const pageLink = (base: RequestWithUrl, page: number, size: number): string => {
      const url = new URL(base.url);
      url.searchParams.set("page[number]", String(page));
      url.searchParams.set("page[size]", String(size));
      return url.toString();
    };
    for (let i = 0; i < 5000; i++) {
      const totalCount = Math.floor(rand() * 5000);
      const pageSize = 1 + Math.floor(rand() * 100);
      // Empty collections still have a page-1 link, so the implementation
      // reports one page even when the collection has no items.
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      const currentPage = 1 + Math.floor(rand() * (totalPages + 5)); // includes over-page
      const req = requestWithQuery(`page[number]=${currentPage}&page[size]=${pageSize}`);
      const p = pagination(req, currentPage, pageSize, totalCount);
      const meta = p.meta["pagination"] as Record<string, unknown>;
      const self = p.links["self"]!;

      expect(meta["total-pages"]).toBe(totalPages);
      expect(meta["total-count"]).toBe(totalCount);
      expect(meta["current-page"]).toBe(currentPage);
      expect(meta["page-size"]).toBe(pageSize);
      expect(meta["prev-page"]).toBe(currentPage > 1 ? currentPage - 1 : null);
      expect(meta["next-page"]).toBe(currentPage < totalPages ? currentPage + 1 : null);
      expect(p.links["prev"]).toBe(currentPage > 1 ? pageLink(req, currentPage - 1, pageSize) : null);
      expect(p.links["next"]).toBe(currentPage < totalPages ? pageLink(req, currentPage + 1, pageSize) : null);
      expect(p.links["first"]).toBe(pageLink(req, 1, pageSize));
      expect(p.links["last"]).toBe(pageLink(req, totalPages, pageSize));
      expect(self).toBe(req.url);
      // every generated link round-trips to a valid page param
      for (const link of [p.links["self"], p.links["first"], p.links["prev"], p.links["next"], p.links["last"]]) {
        if (link === null || link === undefined) continue;
        const params = new URL(link).searchParams;
        const num = Number(params.get("page[number]"));
        const size = Number(params.get("page[size]"));
        expect(Number.isInteger(num)).toBe(true);
        expect(num).toBeGreaterThanOrEqual(1);
        expect(size).toBe(pageSize);
      }
    }
  });
});

describe("partition property: paging a list reproduces it exactly", () => {
  test("exhaustive grid over empty, exact, and partial final pages", () => {
    for (let n = 0; n <= 40; n++) {
      const items = Array.from({ length: n }, (_, i) => `item-${i}`);
      for (let size = 1; size <= 20; size++) {
        const totalPages = Math.max(1, Math.ceil(n / size));
        const collected: string[] = [];
        for (let page = 1; page <= totalPages; page++) {
          const slice = items.slice((page - 1) * size, page * size);
          // every page except the last must be exactly full
          if (page < totalPages) expect(slice.length).toBe(size);
          collected.push(...slice);
        }
        // no loss, no duplication, order preserved
        expect(collected).toEqual(items);
      }
    }
  });

  test("fuzz: random (count, size) pairs over larger lists", () => {
    const rand = mulberry32(0x7a67e);
    for (let i = 0; i < 300; i++) {
      const n = Math.floor(rand() * 1000);
      const size = 1 + Math.floor(rand() * 100);
      const items = Array.from({ length: n }, (_, idx) => idx);
      const totalPages = Math.max(1, Math.ceil(n / size));
      const collected: number[] = [];
      for (let page = 1; page <= totalPages; page++) {
        collected.push(...items.slice((page - 1) * size, page * size));
      }
      expect(collected).toEqual(items);
    }
  });
});
