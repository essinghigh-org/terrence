import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

type MarkdownBlock =
  | Readonly<{ kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }>
  | Readonly<{ kind: "paragraph" | "quote" | "code"; text: string }>
  | Readonly<{ kind: "list"; ordered: boolean; items: ReadonlyArray<{ text: string; children: string[] }> }>
  | Readonly<{ kind: "table"; headers: string[]; rows: string[][] }>;

export function inlineMarkdown(text: string): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|\[[^\]]+\]\([^\)]+\))/g).map((part: string, index: number): ReactNode => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em]">{part.slice(1, -1)}</code>;
    }
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    if (part.startsWith("~~") && part.endsWith("~~")) return <del key={index}>{part.slice(2, -2)}</del>;
    const link = /^\[([^\]]+)\]\(([^\)]+)\)$/.exec(part);
    if (link !== null) {
      const href = link[2] ?? "";
      // Safe links: no scheme (relative paths, fragments), or http(s)/mailto.
      // Anything with another scheme (javascript:, data:, file:) renders as
      // plain text so markdown can never inject navigation.
      const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(href);
      const safe = scheme === null || /^(https?:|mailto:)/.test(href);
      return safe
        ? <a key={index} href={href} className="text-primary underline underline-offset-2" target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined}>{link[1]}</a>
        : link[1];
    }
    return part;
  });
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell): string => cell.trim());
}

function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (current.trim().startsWith("```")) break;
        code.push(current);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading !== null) {
// SAFETY: the markdown heading level is capped at 6 by the parsing regex above.
      blocks.push({ kind: "heading", level: (heading[1] ?? "").length as 1 | 2 | 3 | 4 | 5 | 6, text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    if (line.trim().startsWith("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const headers = splitTableRow(line);
      index += 2; // header row + separator row
      const rows: string[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (!current.trim().startsWith("|")) break;
        rows.push(splitTableRow(current));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const firstItem = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
      const baseIndent = (firstItem?.[1] ?? "").length;
      const items: Array<{ text: string; children: string[] }> = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const itemMatch = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/.exec(current);
        if (itemMatch === null) break;
        const indent = (itemMatch[1] ?? "").length;
        if (indent > baseIndent) {
          // A deeper-indented line continues the previous item as a nested list.
          if (items.length > 0) {
            items[items.length - 1]?.children.push(itemMatch[2] ?? "");
            index += 1;
            continue;
          }
          break;
        }
        if (indent < baseIndent) break;
        items.push({ text: itemMatch[2] ?? "", children: [] });
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (!current.startsWith("> ")) break;
        quote.push(current.slice(2));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join(" ") });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim() === ""
        || current.trim().startsWith("```")
        || /^(#{1,6})\s+/.test(current)
        || /^\s*(?:[-*+]|\d+\.)\s+/.test(current)
        || current.startsWith("> ")
        || current.trim().startsWith("|")) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function renderListItems(items: ReadonlyArray<{ text: string; children: string[] }>, ordered: boolean): JSX.Element[] {
  return items.map((item, itemIndex): JSX.Element => (
    <li key={itemIndex}>
      {inlineMarkdown(item.text)}
      {item.children.length > 0 && (
        ordered
          ? <ol className="mt-1 list-decimal space-y-1 pl-5">{item.children.map((child, childIndex): JSX.Element => <li key={childIndex}>{inlineMarkdown(child)}</li>)}</ol>
          : <ul className="mt-1 list-disc space-y-1 pl-5">{item.children.map((child, childIndex): JSX.Element => <li key={childIndex}>{inlineMarkdown(child)}</li>)}</ul>
      )}
    </li>
  ));
}

export function MarkdownContent({ markdown, className }: Readonly<{ markdown: string; className?: string }>): JSX.Element {
  return (
    <div className={cn("space-y-4", className)}>
      {parseMarkdown(markdown).map((block, index): JSX.Element => {
        if (block.kind === "heading") {
          const headingClassName = cn(
            "font-semibold tracking-tight",
            block.level === 1 ? "text-xl" : block.level === 2 ? "text-lg" : block.level === 3 ? "text-base" : "text-sm",
          );
          if (block.level === 1) return <h1 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h1>;
          if (block.level === 2) return <h2 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h2>;
          if (block.level === 3) return <h3 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h3>;
          if (block.level === 4) return <h4 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h4>;
          if (block.level === 5) return <h5 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h5>;
          return <h6 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h6>;
        }
        if (block.kind === "list") {
          return block.ordered
            ? <ol key={index} className="list-decimal space-y-1 pl-5">{renderListItems(block.items, true)}</ol>
            : <ul key={index} className="list-disc space-y-1 pl-5">{renderListItems(block.items, false)}</ul>;
        }
        if (block.kind === "table") {
          return (
            <div key={index} className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    {block.headers.map((header, headerIndex): JSX.Element => (
                      <th key={headerIndex} className="px-3 py-2 text-left font-semibold">{inlineMarkdown(header)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex): JSX.Element => (
                    <tr key={rowIndex} className="border-b last:border-b-0">
                      {row.map((cell, cellIndex): JSX.Element => (
                        <td key={cellIndex} className="px-3 py-2 align-top text-muted-foreground">{inlineMarkdown(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.kind === "code") return <pre key={index} className="overflow-x-auto rounded-md bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground"><code>{block.text}</code></pre>;
        if (block.kind === "quote") return <blockquote key={index} className="border-l-2 border-primary/40 pl-4 italic text-muted-foreground">{inlineMarkdown(block.text)}</blockquote>;
        return <p key={index}>{inlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}