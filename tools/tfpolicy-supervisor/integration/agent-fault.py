#!/usr/bin/env python3
"""Interrupt only a pinned process in this harness's own delegated subtree."""
import argparse
import json
import os
from pathlib import Path
import signal
import time


def pending_apply(private):
    for audit in private.glob('r-*/audit'):
        try:
            if b'"command":"apply"' not in audit.read_bytes():
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
    parser.add_argument('mode', choices=['crash', 'cancel'])
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    relative = '/' + str(root.relative_to('/sys/fs/cgroup'))
    membership = Path('/proc/self/cgroup').read_text().strip().split(':')[-1]
    if os.geteuid() == 0 or not membership.startswith(relative + '/'):
        raise RuntimeError('must already run unprivileged inside the specified delegated subtree')
    until = time.monotonic() + 50
    while time.monotonic() < until:
        if pending_apply(args.private):
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
                        signal.pidfd_send_signal(descriptor, signal.SIGKILL if args.mode == 'crash' else signal.SIGINT)
                        print(json.dumps({'interrupted': True, 'pendingApplyResourceRpc': True, 'mode': args.mode}))
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
