## Summary

<!-- One paragraph: what changes and why. -->

## Testing

<!-- Commands run and their result, e.g. `bun run typecheck`, backend/frontend suites, focused tests. -->

- [ ] `bun run typecheck` — 0 errors
- [ ] `bun run test:backend`
- [ ] `bun run test:frontend`

## AI assistance disclosure

<!-- Required by AGENTS.md. If AI assistance was used, name the model(s); otherwise delete this section or state "No AI assistance used." -->

- [ ] No AI assistance used, or:
- Models used: <!-- e.g. Hermes Agent (muse-spark), Claude Code, Codex -->

## Checklist

- [ ] No new Drizzle migrations hand-written (`bun run db:generate` output only, or boot DDL for new tables)
- [ ] JSON:API response shape preserved (routes sending `included` declare it in the response schema)
- [ ] New env vars documented in `backend/docs/configuration.md` and `.env.example`
- [ ] Lint budget not grown (`bun run lint:budget`)
