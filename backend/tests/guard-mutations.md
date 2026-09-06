# Critical guard tests

Run `bun backend/scripts/check-guard-mutations.ts` from the repository root.
CI runs this after the SQLite suite. Each case first proves its named test
passes, then changes a production guard in a temporary backend copy. A named
assertion must fail. A changed anchor, syntax error, startup failure, timeout
or output-budget failure fails the check; it cannot count as a detected mutation.
The process has a 30-second deadline and a 2 MiB output budget per test invocation.

| Mutation | Independent outcome |
| --- | --- |
| Exchange state-read for run-read | A team that can read a run cannot obtain state download capabilities |
| Remove a public plan sensitivity field | The public response retains the explicit sensitivity contract |
| Bypass after-value redaction | No secret marker occurs anywhere in the public plan |
| Reverse variable-set name comparison | The explicit earlier-name fixture wins regardless of row insertion order |
| Remove terminal-state deletion predicate | Every explicitly listed active/waiting state retains its execution record |

Principal fixtures use `seedOrg` and `persistSeed`. Related workspace, run and
state rows use `persistExecutionSeed`; callers specify lifecycle status, serial,
payload and any linkage timestamps directly. These builders do not calculate
expected permission or precedence values. The lifecycle cases are literal test
data, independent of production status constants. Serialized Terraform and
OpenTofu plans under `fixtures/engine-plan` additionally test the sanitizer
against real engine output; synthetic extension cases remain useful negative
controls for unrecognized fields.
