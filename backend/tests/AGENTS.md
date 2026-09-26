# Backend test guidance

Prefer confidence at the production owner boundary over test count.

- A bug regression must exercise the production path that owned the bug. Do not reimplement the algorithm in the fixture and assert the fixture's result.
- Do not grep source text merely to prove an implementation detail exists when executable behavior can prove the contract.
- Keep one primary test owner per contract. Add another layer only when it covers a distinct transport, persistence, lifecycle, dialect, security, or compatibility risk.
- Avoid production exports, flags, getters, reset hooks, or injection seams whose only purpose is making private implementation state assertable. If such a seam is unavoidable, document why the behavior cannot be observed at a stronger boundary.
- Static/source inspection is appropriate when the source itself is the independent contract, such as CI permissions, documented configuration, manifests, schema/release compatibility, or generated ownership inventories.
- Prefer extending an existing table/fixture over creating a near-duplicate suite.
- For important regressions, verify the test would fail when the guarded production behavior is deliberately removed or mutated.
- When deleting or consolidating tests, remove obsolete test-only production support in the same change.
