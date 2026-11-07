#!/usr/bin/env python3
"""Interrupt only a pinned process in this harness's own delegated subtree."""
import argparse
import json
import os
from pathlib import Path
import signal
import time


def pending_stage(private, command):
    for audit in private.glob('r-*/audit'):
        try:
            if ('"command":"'+command+'"').encode() not in audit.read_bytes():
                continue
            pending = set()
            for line in (audit.parent/'journal').read_bytes().splitlines():
                row = json.loads(line)
                if row['method'] == 'EvaluateResource':
                    if row['phase'] == 'begin':
                        pending.add(row['id'])
                    else:
                        pending.discard(row['id'])
            if pending:
                return True
        except (FileNotFoundError, ValueError, KeyError):
            continue
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('private', type=Path)
    parser.add_argument('binary', type=Path)
    parser.add_argument('mode', choices=['crash', 'cancel', 'parent-death', 'freeze'])
    parser.add_argument('--command', choices=['plan', 'apply'], default='apply')
    parser.add_argument('--parent-pid', type=int)
    parser.add_argument('--parent-exe', type=Path)
    parser.add_argument('--observe-cgroup', type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    relative = '/' + str(root.relative_to('/sys/fs/cgroup'))
    membership = Path('/proc/self/cgroup').read_text().strip().split(':')[-1]
    if os.geteuid() == 0 or not membership.startswith(relative + '/'):
        raise RuntimeError('must already run unprivileged inside the specified delegated subtree')
    until = time.monotonic() + 50
    while time.monotonic() < until:
        if pending_stage(args.private, args.command):
            for current, _, _ in os.walk(root):
                try:
                    pids = (Path(current)/'cgroup.procs').read_text().split()
                except FileNotFoundError:
                    continue
                for text in pids:
                    pid = int(text)
                    descriptor = None
                    try:
                        descriptor = os.pidfd_open(pid)
                        if os.readlink(f'/proc/{pid}/exe') != str(args.binary):
                            continue
                        if args.mode == 'parent-death':
                            if args.parent_pid is None or args.parent_exe is None:
                                raise RuntimeError('parent death requires a pinned harness child')
                            parent = os.pidfd_open(args.parent_pid)
                            try:
                                member = Path(f'/proc/{args.parent_pid}/cgroup').read_text().strip().split(':')[-1]
                                if not member.startswith(relative + '/') or os.readlink(f'/proc/{args.parent_pid}/exe') != str(args.parent_exe):
                                    raise RuntimeError('parent is not the pinned process in this test subtree')
                                # A stopped RPC cannot complete naturally and hide a missing
                                # parent-liveness check. The owner must cancel and reap it.
                                observed = None
                                if args.observe_cgroup is not None:
                                    observed = args.observe_cgroup.resolve(strict=True)
                                    observed.relative_to(root)
                                    events = (observed/'cgroup.events').read_text()
                                    member = Path(f'/proc/{pid}/cgroup').read_text().strip().split(':')[-1]
                                    expected = '/' + str(observed.relative_to('/sys/fs/cgroup'))
                                    if 'populated 1' not in events or not member.startswith(expected+'/'):
                                        raise RuntimeError('native RPC is not in the observed populated run cgroup')
                                signal.pidfd_send_signal(descriptor, signal.SIGSTOP)
                                signal.pidfd_send_signal(parent, signal.SIGKILL)
                            finally:
                                os.close(parent)
                        else:
                            signal.pidfd_send_signal(descriptor, signal.SIGSTOP if args.mode == 'freeze' else signal.SIGKILL if args.mode == 'crash' else signal.SIGINT)
                        print(json.dumps({'interrupted': True, 'pendingResourceRpc': True, 'command': args.command, 'mode': args.mode, 'observedCgroup': str(observed) if args.mode == 'parent-death' and args.observe_cgroup is not None else None}))
                        return
                    except (ProcessLookupError, FileNotFoundError):
                        continue
                    finally:
                        if descriptor is not None:
                            os.close(descriptor)
        time.sleep(.001)
    raise RuntimeError('did not observe and interrupt the requested native apply RPC')


if __name__ == '__main__':
    main()
