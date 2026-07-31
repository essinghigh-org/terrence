# Security Audit Results

Date: 2026-07-31

## Summary

| # | Finding | Severity | Verdict |
|---|---------|----------|---------|
| 1 | GPG_BINARY_PATH from env | Low | False positive — Bun.spawn() doesn't use a shell; argv[0] only runs the binary directly |
| 2 | Plaintext token fallback in auth.ts | Low-Medium | Acceptable migration pattern; TLS protects transit; resolves on first use |
| 3 | cp path traversal via workspace.name | Medium | Needs path sanitization — `../` in workspace name escapes sandbox |
| 4 | CORS wildcard * in development | Info | False positive — explicitly gated by `NODE_ENV !== "production"` |
| 5 | ADMIN_PASSWORD from env | Info | False positive — standard bootstrap pattern; env cleared from process after use |
| 6 | LIKE % wildcards in basic search | Low | Low risk — the LIKE pattern wraps user input with % wildcards intentionally; UUIDs can't match injected % |
| 7 | ALTER TABLE string format in db/index.ts | Info | False positive — column names come from hardcoded source arrays, not user input |

## Action Items

### P3 (address before next release): item-3
- Add path sanitization for workspace.name in local source copy (backend/src/worker.ts line 826)
- Reject workspaces whose name contains `..`, absolute paths, or `/` outside the expected structure

### P5 (backlog, low urgency): items 1, 6
- Consider hardening GPG_BINARY_PATH with allowlist of known paths
- Add LIKE escape for special characters in search[basic] if fuzzy matching ever supports %/_ wildcards
