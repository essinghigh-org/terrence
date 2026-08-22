# HA conformance suite (29)

Contract: Terrence runs as multiple stateless API pods against a shared
Postgres. Correctness expectations for HA:

- No single pod holds exclusive durable state except via DB advisory locks.
- Run state machine is CAS-guarded (`WHERE status = current`) so concurrent
  workers cannot double-apply a transition.
- Support bundles, agent jobs and webhook deliveries are idempotent under
  at-least-once scheduling.

This document is the stub for the formal suite. The executable harness
will run the existing backend integration tests against two API instances
with a shared DB and assert that no invariant is violated.
