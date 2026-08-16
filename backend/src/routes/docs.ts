import { Elysia } from "elysia";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authPlugin } from "../auth";

/**
 * Bundled documentation (docs/*.md, shipped in the container image).
 *
 * The docs are plain markdown files with a small frontmatter block:
 *
 *   ---
 *   title: Workspaces
 *   category: Workspaces and runs
 *   order: 10
 *   description: Create and configure workspaces.
 *   ---
 *
 * Files are read once at module load and served to any authenticated user.
 * The slug is never used for filesystem access: a 404 is returned unless
 * the slug matches a loaded document exactly, so this route cannot be used
 * for path traversal. The route is additive (not part of the TFE wire
 * contract); the frontend renders the markdown with MarkdownContent.
 */

const DOCS_DIR = join(import.meta.dir, "../../docs");

type DocEntry = Readonly<{
  slug: string;
  title: string;
  category: string;
  order: number;
  description: string;
  markdown: string;
}>;

function parseFrontmatter(slug: string, raw: string): DocEntry | null {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (match === null) return null;
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const title = fields.get("title") ?? slug;
  const category = fields.get("category") ?? "Reference";
  const description = fields.get("description") ?? "";
  const order = Number.parseInt(fields.get("order") ?? "100", 10);
  if (!Number.isFinite(order)) return null;
  return { slug, title, category, order, description, markdown: match[2] ?? "" };
}

function loadDocs(): DocEntry[] {
  try {
    return readdirSync(DOCS_DIR)
      .filter((file): boolean => file.endsWith(".md"))
      .sort()
      .map((file): DocEntry | null => parseFrontmatter(file.slice(0, -3), readFileSync(join(DOCS_DIR, file), "utf8")))
      .filter((entry): entry is DocEntry => entry !== null);
  } catch (error: unknown) {
    // The docs directory is absent in some dev/test layouts; an empty
    // index degrades cleanly instead of failing route registration. The
    // failure is loud so a broken image cannot hide the documentation.
    console.warn(`[terrence] Documentation directory ${DOCS_DIR} could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

const DOCS: readonly DocEntry[] = loadDocs();
const DOCS_BY_SLUG: ReadonlyMap<string, DocEntry> = new Map(DOCS.map((entry): [string, DocEntry] => [entry.slug, entry]));

function docResource(entry: DocEntry, includeMarkdown: boolean): Record<string, unknown> {
  return {
    id: entry.slug,
    type: "docs",
    attributes: {
      slug: entry.slug,
      title: entry.title,
      category: entry.category,
      order: entry.order,
      description: entry.description,
      ...(includeMarkdown ? { markdown: entry.markdown } : {}),
    },
    links: { self: `/api/v2/docs/${entry.slug}` },
  };
}

type DocsCtx = Readonly<{
  user?: Readonly<{ id: string }> | null;
  params: Readonly<{ slug?: string }>;
  set: Readonly<{ status?: number | string }>;
}>;

export const docsRoutes = new Elysia({ name: "docs" })
  .use(authPlugin)
  .get("/api/v2/docs", async ({ user, set }: DocsCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const sorted = [...DOCS].sort((a, b): number =>
      a.category === b.category ? a.order - b.order : a.category.localeCompare(b.category));
    return { data: sorted.map((entry): Record<string, unknown> => docResource(entry, false)) };
  })
  .get("/api/v2/docs/:slug", async ({ user, params, set }: DocsCtx): Promise<unknown> => {
    if (user === null || user === undefined) {
      (set as { status: number }).status = 401;
      return { errors: [{ status: "401", title: "Unauthorized" }] };
    }
    const slug = params.slug ?? "";
    const entry = DOCS_BY_SLUG.get(slug);
    if (entry === undefined) {
      (set as { status: number }).status = 404;
      return { errors: [{ status: "404", title: "Not Found" }] };
    }
    return { data: docResource(entry, true) };
  });