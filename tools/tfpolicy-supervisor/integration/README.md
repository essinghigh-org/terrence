# Stock-engine native qualification

This harness executes the actual supervisor, shim, recorder, Landlock runner and
separately distributed official stock Terraform. It does **not** patch/build the
Terraform engine, download a proprietary tfpolicy binary, enable runtime guards,
or issue an authenticated admission receipt. Its BYOB executable is an original
test-only native gRPC fixture, not a policy-language evaluator. Therefore these
tests qualify transport/isolation/lifecycle behavior, not real tfpolicy licensing
or policy-language semantics. Native callback RPC forwarding has separate recorder
unit tests; this fixture does not exercise an evaluation-time callback.

## Relationship to production qualification

The stock-engine harness described here is one qualification layer. The same CI
workflow separately builds the strict reference engine, requires a non-skipped
`TestNativeOwner` admission matrix, and runs `real-owner.py` with the official
tfpolicy-plugin against the production hosted worker and matching Terrence agent.
The `pinned` and `latest` lanes each require eight hosted-worker cases and six
production-agent cases. See [native execution qualification](../../tfpolicy-engine/HANDOFF.md#official-plugin-ci)
for version pins, evidence, limitations and operator setup.

Stock transport results still report `admitted: false`. Neither this fixture nor
the transport status alone signs a production receipt or authorizes an apply.

## Requirements and truthful reporting

- Native Linux with Landlock ABI >=6, pathname AF_UNIX and trusted host procfs.
- Non-root UID/EUID and zero effective, permitted, inheritable and ambient caps.
- A readable, non-piped kernel `core_pattern`. Hard `RLIMIT_CORE=0` is imposed by
  the runner; it cannot constrain a piped core collector. No host setting is
  changed to make a test pass.
- The existing Landlock runner's `--deny-debug`, `--gate-stdin`, and
  `--connect-unix` support. This is the real repository C executable, compiled
  with warnings-as-errors, not a mock sandbox.
- An **already delegated** writable cgroup-v2 subtree with `cgroup.kill` and
  pre-enabled pids and memory controllers. Each test creates only its own fresh
  leaf, enforces `pids.max=256` and `memory.max=2147483648`, and deletes that leaf
  after atomic kill and a verified `populated 0`. The parent/host cgroup, controller
  delegation, core handler and security settings are never modified.
- Python 3.11+, Go 1.26.10 for the pinned protobuf adapter/fixture, gcc, and official
  Terraform 1.17.1 with a separately trusted executable hash.

`probe.py` checks what the runner already supports, reports exact missing
facilities, and optionally writes GitHub step outputs. Failure of a prerequisite
is **not run**, not a passed native test. `run.py` is stricter: absent prerequisites
are failures and it has no skip/bypass option. `.github/workflows/tfpolicy-native-qualification.yml`
uses ubuntu-latest to probe first, runs supervisor and recorder race tests plus
pure oracle tests, builds the original fixture, and conditionally runs the real
matrix only if all native prerequisites are present. Missing prerequisites fail
the qualification job explicitly after the independent source tests/builds. The workflow has explicit user authorization to prepare a limited cgroup
subtree and temporarily replace the piped core handler on the disposable
GitHub-hosted runner only. It restores the core handler and kills/removes only
its owned subtree in an always-run cleanup step. A root launcher places itself
in that subtree, then drops to the ordinary runner UID before executing the
harness; tested binaries remain non-root with zero capabilities. The standalone
probe and harness never change host settings. A probe-only run is not a successful qualification and cannot turn the job green. Read `native-capabilities.json` and
look for the real `native-results/summary.json` qualification result.

## Build and run

Run the recorder's build script and `build-fixture.sh` against an official
Terraform git checkout containing commit
`ff6329e4c2a159b46ec2b73d36bfa3d0ef6560c9`. Both use committed generated protobuf
transport definitions only. Keep their upstream LICENSE notices. The fixture
source is `fixture/main.go.in` to keep it out of the supervisor's standard-library
Go module. The script compiles it into its own temporary protocol module.

```sh
bash tools/tfpolicy-recorder/build.sh /official/terraform /trusted/recorder
bash tools/tfpolicy-supervisor/integration/build-fixture.sh /official/terraform /trusted/fixture
(cd tools/tfpolicy-supervisor && go build -o /trusted/shim ./cmd/tfpolicy-shim)
(cd tools/tfpolicy-supervisor && go build -o /trusted/supervisor ./cmd/tfpolicy-supervisor)
gcc -O2 -Wall -Wextra -Werror backend/bin/landlock-runner.c -o /trusted/runner
python3 tools/tfpolicy-supervisor/integration/probe.py --runner /trusted/runner --output /tmp/capabilities.json
python3 tools/tfpolicy-supervisor/integration/run.py \
  --terraform /official/bin/terraform --terraform-sha256 "$TRUSTED_EXECUTABLE_SHA256" \
  --runner /trusted/runner --supervisor /trusted/supervisor --shim /trusted/shim \
  --recorder /trusted/recorder --fixture /trusted/fixture \
  --cgroup-root /sys/fs/cgroup/ALREADY_DELEGATED_SUBTREE --output /tmp/new-results
```

The workflow separately downloads the official 1.17.1 Linux AMD64 engine archive
from HashiCorp and verifies its pinned archive SHA256
`4638628058e71a55212b1c563712eac03b902128f40740f3dc8174df12135061`, from the
[official SHA256SUMS](https://releases.hashicorp.com/terraform/1.17.1/terraform_1.17.1_SHA256SUMS).
Only after that check is the extracted executable hash passed to the harness.
The harness records all executable hashes and actual engine version/ABI.
It never substitutes a source-built engine or downloads a proprietary policy plugin.

## Cases and completion boundary

Every engine is launched through a private stdin gate. Its PID/starttime are
captured before release. The engine and supervisor are placed in the owned cgroup
before any shim can connect. A precreated upstream socket directory receives
only a socket-connect grant. The engine is released with exactly `G` only after
the supervisor socket exists. The runner replaces stdin with `/dev/null` and
execs the engine in the same process identity.

The matrix contains:

1. Native ALLOW plan and apply with complete Setup/resource evaluation journal.
2. Native DENY plan and inline/saved-plan apply with error diagnostics and rejected journal.
   Apply-time denial retains the already-mutated local terraform_data state.
3. Missing BYOB executable and Setup error in plan and inline/saved-plan apply with no successful journal.
   Stock apply can exit zero after startup failure; the oracle still rejects it.
4. BYOB process crash during plan/inline-apply/saved-apply resource evaluation, recorded as a failed RPC.
5. Engine killed while a policy RPC blocks. Even an intentional shutdown
   disposition cannot turn incomplete/error RPC evidence into success.
6. Rejected gate byte `X`, proving no policy code ran before authorization.
7. A BYOB descendant using a new session, deliberately surviving process-group
   cleanup. The test requires a residual process before the cgroup fence and
   proves the whole owned group is empty before producing its result.

The fixture verifies private-canary denial, absence of recorder-only environment
and inherited private FD types, and effective blocking of `pidfd_getfd`. The
engine-side sandbox is separately probed using the same runner restrictions.
Policy trees and binaries are copied into trusted immutable test locations.

A positive native case requires engine exit zero, supervisor exit zero, explicit
`engine_shutdown_observed` or `recorder_exited_cleanly` disposition, lossless bounded
capture, and a strict paired successful journal. Negative cases must never produce a complete successful journal. Stock apply
startup failure can return zero, and apply-time policy errors happen after
resource changes. The fixture reports and preserves changed local state for
allow, denial, missing runtime and evaluation crash; rejection is never called
rollback or proof that infrastructure was not changed. Saved-plan applies copy
the actual saved artifact from the initial native ALLOW plan, record its hash,
and pass that artifact to the stock CLI. Inline apply is also tested separately.
Native init with policies has separate ALLOW, missing-runtime and Setup-error
cases. Init can validly have Setup-only evidence for this no-module fixture;
plan/apply still require resource evaluation. Actual stage stdout uses the
pinned JSON UI 1.3 and Terraform 1.17.1 contract, with errors, unknown policy
events and non-AllowResult outcomes rejected by the positive oracle. This Python
fixture does not itself certify the separate TypeScript launcher/verifier. All cases require final cgroup emptiness. Output captures, hashes,
raw test journal, transport status, and result JSON are retained. `admitted` is
always false: this is a qualification test, not a production signer or apply gate.

Local pure tests: `python3 -m unittest -v` in this directory. They cover incomplete
shutdown, denial/RPC errors, missing evaluation, sequence gaps, replay, request
hash tampering and truncation. The initial local environment lacked the required native facilities.
[GitHub-hosted qualification run 41734647582](https://github.com/essinghigh-org/terrence/actions/runs/41734647582)
passed all 21 cases on commit `021b9946b8e2e4e95546f6279354b3782f63cde6`,
with Landlock ABI 8, pathname AF_UNIX, zero process capabilities and delegated
cgroup v2. Every case reported an empty final cgroup and `admitted: false`.
The archived native results prove this fixture matrix only; real-plugin
acceptance and production admission remain separate requirements.
