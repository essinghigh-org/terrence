# Deterministic local test profiles

The repository has five named operational profiles. They allocate their own
temporary root and use a stable fixture seed, so a failed run does not depend
on the normal Terrence instance under `backend/storage`.

```bash
bun run test:profile:list
bun run test:profile -- unit-api
bun run test:profile -- sqlite-cli --seed eng21 --keep-artifacts
bun run test:profile -- postgres-cli --artifact-dir ./test-artifacts
bun run test:profile -- sandbox
bun run test:profile -- browser
```

`unit-api` is explicitly simulated. The CLI profiles run the real pinned
Terraform/OpenTofu binaries from `backend/tests/e2e/cli_matrix.json`; they
reject `SIMULATED_RUNS=true` and never turn a PostgreSQL profile into SQLite.
The `sandbox` profile requires the production Landlock helper and fails when
the host cannot provide it. `browser` runs the frontend WebView journeys with
an ephemeral server port.

The default seed is `eng21`. Set `TERRENCE_E2E_SEED` or pass `--seed` to
reproduce the same fixture names. The runner prints a reproduction command at
startup and writes `profile.json`, `reproduce.sh`, redacted stdout/stderr, and
failure details below the temporary profile directory. Use `--keep-artifacts`
or `--artifact-dir` when those files need to survive cleanup.

The PostgreSQL profile expects a local disposable PostgreSQL service. Set
`DATABASE_URL` to an administrative `postgres://` URL when the default local
URL is not suitable; the provider harness creates and drops an isolated test
database. No cloud credentials are needed for the core unit/API, SQLite, or
browser profiles.
