#!/usr/bin/env python3
"""Read/test existing runner facilities. Never changes host security settings."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile


def detail(error):
    extra = getattr(error, "stderr", None) or getattr(error, "output", None)
    if isinstance(extra, bytes):
        extra = extra.decode(errors="replace")
    return str(error) + ((": " + extra.strip()[:2000]) if extra else "")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--runner", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--cgroup-root", type=Path)
    a = p.parse_args()
    report = {"ready": False, "missing": [], "uid": os.getuid(), "euid": os.geteuid()}
    if os.getuid()==0 or os.geteuid()==0:
        report["missing"].append("non-root uid and euid")
    try:
        status=dict(line.split(":",1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
        report["capabilities"]={key:status[key].strip() for key in ("CapEff","CapPrm","CapInh","CapAmb")}
        if any(int(value,16)!=0 for value in report["capabilities"].values()):
            report["missing"].append("zero effective/permitted/inheritable/ambient capabilities")
    except Exception as e:
        report["missing"].append("cannot verify capabilities: "+str(e))
    try:
        report["landlock_abi"] = int(subprocess.check_output([str(a.runner), "--probe"], stderr=subprocess.STDOUT, timeout=5))
        if report["landlock_abi"] < 6:
            report["missing"].append("Landlock ABI >=6")
    except Exception as e:
        report["missing"].append("Landlock probe: " + detail(e))
    try:
        with tempfile.TemporaryDirectory(prefix="tfp-probe-") as d:
            with socket.socket(socket.AF_UNIX) as s:
                s.bind(str(Path(d) / "socket"))
        report["af_unix"] = True
    except Exception as e:
        report["missing"].append("AF_UNIX socket: " + str(e))
    try:
        executable = Path("/usr/bin/true").resolve(strict=True)
        command = [str(a.runner), "--deny-debug", "--rx=" + str(executable)]
        for path in ("/usr/lib", "/lib", "/lib64"):
            if Path(path).exists():
                command.append("--rx=" + str(Path(path).resolve()))
        command += ["--", str(executable)]
        subprocess.run(command, check=True, capture_output=True, timeout=5)
        report["deny_debug"] = True
    except Exception as e:
        report["missing"].append("Landlock + deny-debug child execution: " + detail(e))
    root = a.cgroup_root
    if root is None:
        mount = Path("/sys/fs/cgroup")
        try:
            relative = next(x[3:] for x in Path("/proc/self/cgroup").read_text().splitlines() if x.startswith("0::"))
            candidate = mount / relative.lstrip("/")
            root = candidate if candidate.is_dir() and candidate.is_relative_to(mount) else mount
        except Exception:
            root = mount
    report["cgroup_root"] = str(root)
    leaf = None
    try:
        if not (root / "cgroup.controllers").is_file():
            raise RuntimeError("not a cgroup-v2 mount/subtree")
        leaf = root / ("tfpolicy-probe-" + os.urandom(8).hex())
        leaf.mkdir()
        if not (leaf / "cgroup.kill").is_file():
            raise RuntimeError("cgroup.kill is absent")
        # Opening tests delegation without moving any existing process. The full
        # harness tests moving/cleaning only its freshly spawned test processes.
        with (leaf / "cgroup.procs").open("w"):
            pass
        (leaf / "cgroup.kill").write_text("1")
        if "populated 1" in (leaf / "cgroup.events").read_text():
            raise RuntimeError("fresh delegated cgroup unexpectedly populated")
        # These limits affect only our fresh empty leaf, never host settings
        # or the delegated parent. Controllers must already be delegated.
        for name,limit in (("pids.max",256),("memory.max",2147483648)):
            (leaf/name).write_text(str(limit))
            if int((leaf/name).read_text())!=limit:
                raise RuntimeError("finite stage limit not enforced: "+name)
        report["delegated_cgroup_v2"] = True
        report["owned_leaf_limits"]={"pids.max":256,"memory.max":2147483648}
    except Exception as e:
        report["missing"].append("preexisting writable cgroup-v2 delegation: " + str(e))
    finally:
        if leaf is not None and leaf.exists():
            leaf.rmdir()
    for key, path in (("core_pattern", "/proc/sys/kernel/core_pattern"), ("ptrace_scope", "/proc/sys/kernel/yama/ptrace_scope")):
        try:
            report[key] = Path(path).read_text().strip()
        except OSError as e:
            report[key] = str(e)
    core=report.get("core_pattern","")
    if not core or core.startswith("[Errno") or core.lstrip().startswith("|"):
        report["missing"].append("verifiable non-piped core_pattern (RLIMIT_CORE=0 does not bound piped collectors)")
    report["ready"] = not report["missing"]
    report["native_qualification"] = "eligible_to_run" if report["ready"] else "not_run_missing_facilities"
    a.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if path := os.getenv("GITHUB_OUTPUT"):
        with open(path, "a") as f:
            f.write("ready=" + str(report["ready"]).lower() + "\n")
            f.write("cgroup_root=" + str(root) + "\n")
    if path := os.getenv("GITHUB_STEP_SUMMARY"):
        with open(path, "a") as f:
            f.write("## Native tfpolicy facilities\n\n")
            f.write("Eligible for live qualification.\n" if report["ready"] else "**Native qualification NOT RUN.** Missing facilities:\n\n" + "\n".join("- " + x for x in report["missing"]) + "\n")


if __name__ == "__main__":
    main()
