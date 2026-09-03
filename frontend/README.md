# Terrence frontend

React 19 + TypeScript web UI for Terrence. Built with the Bun native
bundler (`Bun.build` via `scripts/build.ts` with `bun-plugin-tailwind`);
typechecked with `tsc6 -b` (`tsconfig.app.json` + `tsconfig.tools.json`).
There is no Vite, no HMR plugin, and no `.oxlintrc.json` in this workspace.

## Commands (run from `frontend/`)

| Command | Purpose |
|---|---|
| `bun run build` | Typecheck (`tsc6 -b`) then emit the static bundle consumed by the backend (`dist/`, served by the API). The backend `security-regression` suite asserts on this output, so build before running backend API tests. |
| `bun test` | Unit tests (`tests/*.test.tsx`, `tests/*.test.ts`) under `bun:test` with mocked `fetch`. |
| `bun run test:browser` | Browser E2E and accessibility suite (Bun.WebView). Needs `bun run build` first. |
| `bun run typecheck` | `tsc6 -b` over the app and tools projects. |

## Layout

- `src/views/` — page-level components (`WorkspaceDetail`, `RunDetail`, `RunList`, ...).
- `src/components/` — reusable UI (`PlanOutput`, `ApplyOutput`, `ProviderIcon`, `ui/` primitives built on `@base-ui/react`).
- `src/lib/api.ts` — `fetchApi()` wrapper with token refresh; every view fetches fresh data on mount (no response cache).
- `scripts/build.ts` — production bundler entry.
- `tests/` — unit tests colocated by area; `tests/browser/` — WebView E2E.

## Conventions

- Local state with `useState`/`useEffect`; no global state manager.
- Tailwind CSS for styling; status symbols use colored text (`+`/`~`/`-`), not badges.
- Collapsible panels default to collapsed with `→`/`↓` chevrons.
