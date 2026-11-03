# Stock Terraform policy protocol compatibility harness

This is a test-only investigation of a stock Terraform + operator-provided
`tfpolicy-plugin` integration. **It does not enable tfpolicy execution in
Terrence, remove an unsupported-runtime guard, or certify production support.**

## Run

On Linux amd64 with Git, curl, unzip, Python 3, Go with toolchain auto-download,
and permission to create local plugin sockets:

```sh
bash backend/tests/compat/tfpolicy-stock/run.sh
```

The script downloads the **official Terraform 1.17.1 binary** from HashiCorp,
verifies the published SHA256, and checks out protocol source at
`ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9`. It builds our mock runtime and
transparent recorder against that source. Terraform itself is not rebuilt or
patched. Source dependencies require Go 1.26.10 and are verified by Go's checksum
mechanism. Downloads, binaries and state live in temporary directories removed
when the script exits. No proprietary tfpolicy binary is downloaded or executed.
No Terraform or plugin binaries are committed, cached or uploaded as artifacts.

The existing CI workflow runs this job with contents-read permission, without
secrets passed to commands, credential persistence, containers, privileged
operations, production endpoints or deployment steps. Only the built-in
`terraform_data` resource is used. An allowed saved plan creates local test
state; no external infrastructure is changed.

## What it verifies

The actual stock CLI talks to our transparent recorder using go-plugin protocol
1 with automatic mutual TLS. The recorder starts the mock plugin through a
second AutoMTLS connection and translates the callback broker service ID.
The live mock validates its resource type, provider/module/operation metadata and
input, then makes an actual GetResources callback through both broker
connections. In-memory gRPC tests independently cover callback payload forwarding.

Live cases cover a missing executable, setup error, process death during setup,
process death during evaluation, aggregate-only denial, and allowance. The
fixture only admits allowance, checks exact saved-plan hash and policy-scope
identity, and rejects changed identities before applying its local-only plan. A second
matrix applies genuinely policy-enabled saved plans with the same runtime
failure/denial/allowance cases. It asserts local resulting state is retained
and distinguishes Terraform exit status from policy compliance. The fixture
explicitly expects the inline provider evaluation as well as resource evaluation.

The recorder tests exercise raw aggregate results that Terraform's JSON UI can
omit, contradictory allowance/error responses, missing/duplicate expected
calls, unknown outcomes and incomplete callbacks. No Terraform callback
semantics are reimplemented: messages are forwarded to the original caller.

## Limits and licensing

The expected one-resource inventory is a **test oracle**, not a production
inventory generator. The admission example is not Terrence's production owner
boundary. A green job proves this protocol fixture, not end-to-end production
policy enforcement, exhaustive evaluation coverage or the proprietary runtime's
compatibility. It must not be used to justify bypassing an existing guard.

Still required: comprehensive graph coverage, protected recorder evidence and
process fencing, real authorized BYOB runtime acceptance, initialization policy
coverage, production post-apply state handling, server admission and hosted/agent
integration. Apply-time policy checks may run after infrastructure changes;
the live fixture checks that failed post-apply policy outcomes do not discard
the local state or pretend the infrastructure change was rolled back.

The harness is original test code using upstream protocol types at build time.
Downloaded Terraform/source retains its upstream licensing. Public availability
or a passing mock does not establish permission to redistribute or commercially
use the proprietary policy runtime. Operators must supply a suitably licensed
runtime before any future integration is enabled.

AI-assisted changes must be disclosed, including the models used, in the PR
according to the repository's contribution instructions.
