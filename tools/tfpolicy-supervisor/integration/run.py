#!/usr/bin/env python3
"""Native qualification harness. Never creates an admission receipt or enables guards."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

LIMIT = 16 * 1024 * 1024
METHODS = {"Setup", "EvaluateResource", "EvaluateProvider", "EvaluateModule", "GetResources", "GetDataSource"}


def digest(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def write_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(value, f)
        f.write("\n")


def journal_valid(data):
    """Strict test oracle only. Production admission uses its own verifier."""
    if not data or len(data) > LIMIT or not data.endswith(b"\n"):
        return False
    pending, seen, setup, resource = {}, set(), False, False
    try:
        lines = data.splitlines()
        if len(lines) > 100000:
            return False
        for index, line in enumerate(lines):
            r = json.loads(line)
            if set(r) != {"sequence", "id", "method", "phase", "requestSha256", "result", "error"}:
                return False
            if type(r["sequence"]) is not int or r["sequence"] != index:
                return False
            if not isinstance(r["id"], str) or not r["id"] or r["method"] not in METHODS:
                return False
            if not isinstance(r["requestSha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", r["requestSha256"]):
                return False
            key = (r["method"], r["requestSha256"])
            if r["phase"] == "begin":
                if r["id"] in seen or r["result"] is not None or r["error"] is not None:
                    return False
                if r["method"] != "Setup" and not setup:
                    return False
                if r["method"] == "Setup" and (setup or pending):
                    return False
                seen.add(r["id"])
                pending[r["id"]] = key
            elif r["phase"] == "end":
                if pending.pop(r["id"], None) != key or r["error"] is not None:
                    return False
                if r["method"].startswith("Evaluate"):
                    if r["result"] != "ALLOW":
                        return False
                    resource |= r["method"] == "EvaluateResource"
                elif r["result"] is not None:
                    return False
                setup |= r["method"] == "Setup"
            else:
                return False
        return setup and resource and not pending
    except (ValueError, TypeError, KeyError):
        return False


class Capture:
    def __init__(self, stream, path):
        self.path, self.failed, self.count = path, None, 0
        self.thread = threading.Thread(target=self._copy, args=(stream,), daemon=True)
        self.thread.start()

    def _copy(self, stream):
        try:
            with open(self.path, "xb") as out:
                while chunk := stream.read(4096):
                    remaining = LIMIT - self.count
                    out.write(chunk[:max(0, remaining)])
                    self.count += len(chunk)
                    if self.count > LIMIT:
                        self.failed = "capture limit exceeded"
        except Exception as e:
            self.failed = str(e)
        finally:
            stream.close()

    def finish(self):
        self.thread.join(3)
        if self.thread.is_alive() or self.failed:
            raise RuntimeError(self.failed or "capture did not close")
        return digest(self.path)


class Fence:
    def __init__(self, root):
        # Never alter or kill the delegated parent. Only this fresh leaf is owned.
        self.path = root / ("tfpolicy-ci-" + os.urandom(8).hex())
        self.path.mkdir(mode=0o700)
        try:
            for name,limit in (("pids.max",256),("memory.max",2147483648)):
                (self.path/name).write_text(str(limit))
                if int((self.path/name).read_text())!=limit:
                    raise RuntimeError("finite stage limit not enforced: "+name)
        except Exception:
            self.path.rmdir()
            raise
        if not (self.path / "cgroup.kill").is_file():
            self.path.rmdir()
            raise RuntimeError("delegated cgroup v2 with cgroup.kill is required")

    def add(self, process):
        (self.path / "cgroup.procs").write_text(str(process.pid))

    def populated(self):
        return "populated 1" in (self.path / "cgroup.events").read_text()

    def close(self):
        (self.path / "cgroup.kill").write_text("1")
        until = time.monotonic() + 5
        while self.populated() and time.monotonic() < until:
            time.sleep(0.02)
        if self.populated():
            raise RuntimeError("cgroup is not empty after kill; terminal fence failed")
        self.path.rmdir()


def process_identity(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
    return int(fields[19])


def sandbox_args(runner, binary, work, read_roots=(), sockets=(), gate=False):
    args = [str(runner), "--deny-debug", "--rwx=" + str(work), "--rx=" + str(binary)]
    for root in read_roots:
        args.append("--ro=" + str(root))
    for root in sockets:
        args.append("--connect-unix=" + str(root))
    for path in ("/usr/lib", "/lib", "/lib64"):
        if Path(path).exists():
            args.append("--rx=" + str(Path(path).resolve()))
    for path in ("/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/ld.so.cache", "/dev/urandom", "/dev/random"):
        if Path(path).exists():
            args.append("--ro=" + str(Path(path).resolve()))
    args += ["--rw=/dev/null", "--cwd=" + str(work)]
    if gate:
        args.append("--gate-stdin")
    return args + ["--", str(binary)]


def await_gate(process, runner):
    until = time.monotonic() + 5
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError("runner exited before execution gate")
        try:
            if Path(f"/proc/{process.pid}/exe").resolve() == runner:
                return process_identity(process.pid)
        except FileNotFoundError:
            pass
        time.sleep(0.01)
    raise RuntimeError("runner did not reach stable executable identity")


def wait_file(path, process, seconds=5):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if path.exists():
            return
        if process.poll() is not None:
            raise RuntimeError("supervisor exited before socket ready")
        time.sleep(0.01)
    raise RuntimeError("supervisor socket timeout")


def run_case(args, bins, root, output, mode, stage):
    case = mode + "-" + stage
    out = output / case
    out.mkdir(mode=0o700)
    base = root / case
    base.mkdir(mode=0o700)
    work, policy, private, sockets, temporary = [base / n for n in ("w", "p", "s", "u", "t")]
    for path in (work, policy, private, sockets, temporary):
        path.mkdir(mode=0o700)
    canary = private / "secret"
    canary.write_text("must-never-be-visible-to-engine-or-BYOB")
    (work / "main.tf").write_text('resource "terraform_data" "proof" { input = "native-ci" }\n')
    write_json(policy / "fixture.json", {"mode": mode, "forbidden_path": str(canary)})
    os.chmod(policy / "fixture.json", 0o444)
    os.chmod(policy, 0o555)
    env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work), "TF_IN_AUTOMATION": "1", "CHECKPOINT_DISABLE": "1", "TF_INPUT": "0"}
    fence = Fence(args.cgroup_root)
    processes, captures = [], []
    result = {"case": case, "admitted": False}
    try:
        # Confirm engine-side filesystem and mandatory debug filter confinement.
        probe = subprocess.Popen(sandbox_args(bins["runner"], bins["fixture"], work, gate=True) + ["sandbox-probe", str(canary)], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        processes.append(probe)
        fence.add(probe)
        await_gate(probe, bins["runner"])
        probe_out, probe_err = probe.communicate(b"G", timeout=10)
        if probe.returncode != 0:
            raise RuntimeError("engine sandbox probe failed: " + probe_err.decode(errors="replace"))
        init = subprocess.Popen(sandbox_args(bins["runner"], bins["terraform"], work, gate=True) + ["init", "-input=false", "-no-color"], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        processes.append(init)
        fence.add(init)
        await_gate(init, bins["runner"])
        init_out, init_err = init.communicate(b"G", timeout=30)
        (out / "init.stdout").write_bytes(init_out)
        (out / "init.stderr").write_bytes(init_err)
        if init.returncode:
            raise RuntimeError("stock Terraform init failed")
        socket_path = private / "boot.sock"
        journal = private / "journal"
        recorder_config = private / "recorder.json"
        write_json(recorder_config, {
            "schemaVersion": 1, "pluginPath": str(bins["fixture"] if mode != "missing" else private / "missing-plugin"),
            "pluginSha256": digest(bins["fixture"]), "landlockRunnerPath": str(bins["runner"]),
            "landlockRunnerSha256": digest(bins["runner"]), "policyReadRoots": [str(policy)],
            "temporaryDirectory": str(temporary), "socketDirectory": str(sockets),
        })
        env.update(TF_POLICY_PLUGIN=str(bins["shim"]), TFPOLICY_SUPERVISOR_SOCKET=str(socket_path))
        command = sandbox_args(bins["runner"], bins["terraform"], work, [policy], [private, sockets], gate=True)
        # Read+execute only this exact immutable shim, never the trusted bin dir.
        command.insert(1, "--rx=" + str(bins["shim"]))
        command += [stage, "-input=false", "-no-color", "-policies=" + str(policy)]
        if stage == "apply":
            command.append("-auto-approve")
        engine = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        processes.append(engine)
        captures += [Capture(engine.stdout, out / "engine.stdout"), Capture(engine.stderr, out / "engine.stderr")]
        fence.add(engine)
        start = await_gate(engine, bins["runner"])
        nonce = os.urandom(32).hex()
        config = private / "supervisor.json"
        write_json(config, {
            "socket_path": str(socket_path), "engine_pid": engine.pid, "engine_start_time": start, "peer_uid": os.getuid(),
            "shim_path": str(bins["shim"]), "shim_sha256": digest(bins["shim"]),
            "recorder_path": str(bins["recorder"]), "recorder_sha256": digest(bins["recorder"]),
            "recorder_config_path": str(recorder_config), "journal_path": str(journal), "run_nonce": nonce,
            "startup_seconds": 5, "lifetime_seconds": 45, "max_journal_bytes": LIMIT,
        })
        supervisor = subprocess.Popen([str(bins["supervisor"]), "serve", "--config", str(config)], env={"PATH": "/usr/bin:/bin"}, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        processes.append(supervisor)
        captures += [Capture(supervisor.stdout, out / "supervisor.stdout"), Capture(supervisor.stderr, out / "supervisor.stderr")]
        fence.add(supervisor)
        wait_file(socket_path, supervisor)
        if process_identity(engine.pid) != start or Path(f"/proc/{engine.pid}/exe").resolve() != bins["runner"]:
            raise RuntimeError("engine escaped gate before socket readiness")
        engine.stdin.write(b"X" if mode == "gate-denied" else b"G")
        engine.stdin.close()
        until, cancelled = time.monotonic() + 40, False
        while engine.poll() is None and time.monotonic() < until:
            if any(c.failed for c in captures):
                raise RuntimeError("output capture failed")
            if mode == "hang" and not cancelled and journal.exists():
                records = journal.read_bytes()
                if b'"method":"EvaluateResource"' in records and b'"phase":"begin"' in records:
                    engine.kill()
                    cancelled = True
            time.sleep(0.02)
        if engine.poll() is None:
            raise RuntimeError("native engine timeout")
        supervisor.wait(timeout=8)
        hashes = [c.finish() for c in captures]
        data = journal.read_bytes() if journal.exists() else b""
        status_path = Path(str(journal) + ".status.json")
        status = json.loads(status_path.read_text())
        if status.get("completed") is not False or status.get("run_nonce") != nonce:
            raise RuntimeError("invalid or falsely completed supervisor status")
        complete = journal_valid(data)
        if mode in ("allow", "orphan"):
            if engine.returncode != 0 or supervisor.returncode != 0 or not complete or status.get("transport") not in ("engine_shutdown_observed", "recorder_exited_cleanly"):
                raise RuntimeError("native positive control did not finish with complete journal and explicit disposition")
        elif engine.returncode == 0 or complete:
            raise RuntimeError("negative native case did not fail closed")
        if mode == "gate-denied" and data:
            raise RuntimeError("policy code ran despite rejected gate")
        if mode == "hang" and not cancelled:
            raise RuntimeError("in-flight cancellation scenario never reached evaluation")
        if stage == "apply" and mode == "deny":
            state = work / "terraform.tfstate"
            if state.exists() and json.loads(state.read_text()).get("resources"):
                raise RuntimeError("denied apply created managed resources")
        result.update(engine_exit=engine.returncode, supervisor_exit=supervisor.returncode,
                      disposition=status["transport"], journal_valid=complete,
                      stdout_sha256=hashes[0], journal_sha256=hashlib.sha256(data).hexdigest(),
                      residual_processes_before_fence=fence.populated())
        if mode == "orphan" and not result["residual_processes_before_fence"]:
            raise RuntimeError("daemonized-descendant cleanup scenario was not exercised")
        (out / "journal.jsonl").write_bytes(data)
        write_json(out / "transport-status.json", status)
    finally:
        # Exact cgroup leaf, never the host/delegated parent, is killed and proven
        # empty. No terminal qualification is emitted until this succeeds.
        try:
            fence.close()
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
            for capture in captures:
                capture.thread.join(3)
    result["cgroup_empty"] = True
    result["qualification_passed"] = True
    write_json(out / "result.json", result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("terraform", "runner", "supervisor", "shim", "recorder", "fixture"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--terraform-sha256", required=True, help="trusted expected hash of official executable, not archive")
    parser.add_argument("--terraform-version", default="1.17.1")
    parser.add_argument("--cgroup-root", type=Path, required=True, help="already delegated writable cgroup-v2 subtree")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if sys.platform != "linux":
        raise RuntimeError("native Linux required; qualification cannot skip")
    if os.getuid()==0 or os.geteuid()==0:
        raise RuntimeError("non-root uid/euid required")
    process_status=dict(line.split(":",1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
    if any(int(process_status[name],16)!=0 for name in ("CapEff","CapPrm","CapInh","CapAmb")):
        raise RuntimeError("all process capability sets must be zero")
    core_pattern=Path("/proc/sys/kernel/core_pattern").read_text().strip()
    if not core_pattern or core_pattern.startswith("|"):
        raise RuntimeError("non-piped core_pattern required; host settings will not be changed")
    args.cgroup_root = args.cgroup_root.resolve(strict=True)
    if not (args.cgroup_root / "cgroup.controllers").is_file():
        raise RuntimeError("real delegated cgroup-v2 subtree required")
    args.output = args.output.resolve()
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    if not re.fullmatch(r"[0-9a-f]{64}", args.terraform_sha256) or digest(args.terraform) != args.terraform_sha256:
        raise RuntimeError("official Terraform executable checksum mismatch")
    version = json.loads(subprocess.check_output([str(args.terraform.resolve()), "version", "-json"], timeout=10))
    if version["terraform_version"] != args.terraform_version:
        raise RuntimeError("official Terraform version mismatch")
    abi = int(subprocess.check_output([str(args.runner.resolve()), "--probe"], timeout=5).strip())
    if abi < 6:
        raise RuntimeError("Landlock ABI >=6 required; qualification cannot skip")
    with tempfile.TemporaryDirectory(prefix="tfi-", dir="/tmp") as temp:
        root = Path(temp)
        with socket.socket(socket.AF_UNIX) as probe:
            probe.bind(str(root / "probe.sock"))
        (root / "probe.sock").unlink()
        bin_dir = root / "b"
        bin_dir.mkdir(mode=0o700)
        bins = {}
        for name in ("terraform", "runner", "supervisor", "shim", "recorder", "fixture"):
            target = bin_dir / name
            shutil.copyfile(getattr(args, name).resolve(strict=True), target)
            os.chmod(target, 0o555)
            bins[name] = target
        write_json(args.output / "provenance.json", {"terraform_version": args.terraform_version, "landlock_abi": abi,
                    "executable_sha256": {k: digest(v) for k, v in bins.items()}, "admitted": False})
        results = []
        for mode, stage in (("allow", "plan"), ("deny", "plan"), ("missing", "plan"), ("crash", "plan"),
                            ("hang", "plan"), ("gate-denied", "plan"), ("orphan", "plan"), ("allow", "apply"), ("deny", "apply")):
            try:
                results.append(run_case(args, bins, root, args.output, mode, stage))
            except Exception as e:
                write_json(args.output / "failure.json", {"case":mode+"-"+stage,"qualification_passed":False,"admitted":False,"error":str(e)})
                raise
            print("PASS", mode, stage, flush=True)
        write_json(args.output / "summary.json", {"qualification_passed": True, "admitted": False, "cases": results})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Native integration FAILED:", e, file=sys.stderr)
        sys.exit(1)
