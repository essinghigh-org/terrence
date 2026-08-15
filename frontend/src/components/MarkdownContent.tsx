import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

type MarkdownBlock =
  | Readonly<{ kind: "heading"; level: 1 | 2 | 3; text: string }>
  | Readonly<{ kind: "paragraph" | "quote" | "code"; text: string }>
  | Readonly<{ kind: "list"; items: string[] }>;

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
      const safe = href.startsWith("/") || href.startsWith("./") || href.startsWith("#") || /^(https?:|mailto:)/.test(href);
      return safe
        ? <a key={index} href={href} className="text-primary underline underline-offset-2" target={href.startsWith("http") ? "_blank" : undefined} rel={href.startsWith("http") ? "noreferrer" : undefined}>{link[1]}</a>
        : link[1];
    }
    return part;
  });
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
    if (/^```(?:\w+)?$/.test(line.trim())) {
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
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading !== null) {
// SAFETY: the markdown heading level is capped at 3 by the parsing regex above.
      blocks.push({ kind: "heading", level: (heading[1] ?? "").length as 1 | 2 | 3, text: heading[2] ?? "" });
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        if (!/^\s*[-*+]\s+/.test(current)) break;
        items.push(current.replace(/^\s*[-*+]\s+/, ""));
        index += 1;
      }
      blocks.push({ kind: "list", items });
      continue;
    }
    if (line.startsWith("> ")) {
      blocks.push({ kind: "quote", text: line.slice(2) });
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim() === "" || /^```(?:\w+)?$/.test(current.trim()) || /^(#{1,3})\s+/.test(current) || /^\s*[-*+]\s+/.test(current) || current.startsWith("> ")) break;
      paragraph.push(current);
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

export function MarkdownContent({ markdown, className }: Readonly<{ markdown: string; className?: string }>): JSX.Element {
  return (
    <div className={cn("space-y-4", className)}>
      {parseMarkdown(markdown).map((block, index): JSX.Element => {
        if (block.kind === "heading") {
          const headingClassName = cn("font-semibold tracking-tight", block.level === 1 ? "text-xl" : block.level === 2 ? "text-lg" : "text-base");
          if (block.level === 1) return <h1 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h1>;
          if (block.level === 2) return <h2 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h2>;
          return <h3 key={index} className={headingClassName}>{inlineMarkdown(block.text)}</h3>;
        }
        if (block.kind === "list") {
          return <ul key={index} className="list-disc space-y-1 pl-5">{block.items.map((item, itemIndex): JSX.Element => <li key={itemIndex}>{inlineMarkdown(item)}</li>)}</ul>;
        }
        if (block.kind === "code") return <pre key={index} className="overflow-x-auto rounded-md bg-code-background p-4 font-mono text-xs leading-5 text-code-foreground"><code>{block.text}</code></pre>;
        if (block.kind === "quote") return <blockquote key={index} className="border-l-2 border-primary/40 pl-4 italic text-muted-foreground">{inlineMarkdown(block.text)}</blockquote>;
        return <p key={index}>{inlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}
