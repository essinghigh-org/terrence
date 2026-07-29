#!/usr/bin/env python3
"""
Jules API Helper — create, poll, and pull results from Jules coding sessions.
Usage:
  export JULES_API_KEY="..."
  python3 scripts/jules_helper.py create --source ... --title "..." --prompt "..." --branch master
  python3 scripts/jules_helper.py list
  python3 scripts/jules_helper.py get SESSION_ID
  python3 scripts/jules_helper.py send SESSION_ID "follow-up"
  python3 scripts/jules_helper.py approve SESSION_ID
  python3 scripts/jules_helper.py patch SESSION_ID -o /tmp/patch.diff
"""

import json, os, sys, time, urllib.request, urllib.error
API_BASE = "https://jules.googleapis.com/v1alpha"

def api_key():
    k = os.environ.get("JULES_API_KEY")
    if not k:
        print("ERR: Set JULES_API_KEY", file=sys.stderr)
        sys.exit(1)
    return k

def headers():
    return {"x-goog-api-key": api_key(), "Content-Type": "application/json"}

def api(path, method="GET", body=None):
    url = f"{API_BASE}/{path.lstrip('/')}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers())
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)

def cmd_create(args):
    body = {
        "prompt": args.prompt,
        "sourceContext": {
            "source": args.source,
            "githubRepoContext": {"startingBranch": args.branch},
        },
        "title": args.title,
        "requirePlanApproval": args.require_approval,
    }
    if args.pr:
        body["automationMode"] = "AUTO_CREATE_PR"
    result = api("sessions", method="POST", body=body)
    sid = result.get("id")
    print(f"Session: {sid}")
    print(f"  URL: https://jules.google.com/session/{sid}")
    print(f"  State: {result.get('state')}")
    if args.poll:
        for i in range(args.poll):
            s = api(f"sessions/{sid}")
            st = s.get("state")
            if st in ("COMPLETED","FAILED","CANCELLED"):
                print(f"  -> {st}")
                if st == "COMPLETED":
                    for o in s.get("outputs",[]):
                        if "changeSet" in o:
                            cs = o["changeSet"]
                            print(f"  Base: {cs.get('baseCommitId')}")
                            print(f"  Msg: {cs.get('suggestedCommitMessage')}")
                        if "pullRequest" in o:
                            print(f"  PR: {o['pullRequest'].get('url')}")
                return
            print(f"  {i+1}/{args.poll}: {st}")
            time.sleep(10)
        print("  Poll limit hit")

def cmd_list(args):
    r = api(f"sessions?pageSize={args.limit}")
    print(f"{'ID':<22} {'State':<14} {'Title':<40}")
    print("-"*80)
    for s in r.get("sessions",[]):
        sid = s.get("id","?").replace("sessions/","")[:20]
        print(f"{sid:<22} {s.get('state','?'):<14} {s.get('title','?'):<40}")

def cmd_get(args):
    print(json.dumps(api(f"sessions/{args.session_id}"), indent=2))

def cmd_send(args):
    print(json.dumps(api(f"sessions/{args.session_id}:sendMessage", method="POST", body={"prompt": args.message}), indent=2))

def cmd_approve(args):
    print(json.dumps(api(f"sessions/{args.session_id}:approvePlan", method="POST", body={}), indent=2))

def cmd_patch(args):
    r = api(f"sessions/{args.session_id}")
    for o in r.get("outputs",[]):
        if "changeSet" in o:
            patch = o["changeSet"].get("gitPatch",{}).get("unidiffPatch")
            if patch:
                if args.output:
                    with open(args.output,"w") as f:
                        f.write(patch)
                    print(f"Patch written to {args.output}")
                else:
                    print(patch)
            msg = o["changeSet"].get("suggestedCommitMessage")
            if msg:
                print(f"# Suggested commit msg: {msg}")
            return
    print("No patch in session output.")

if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(description="Jules API Helper")
    s = p.add_subparsers(dest="cmd")
    # create
    sp = s.add_parser("create", help="Create session")
    sp.add_argument("--source", required=True)
    sp.add_argument("--title", required=True)
    sp.add_argument("--prompt", required=True)
    sp.add_argument("--branch", default="master")
    sp.add_argument("--pr", action="store_true")
    sp.add_argument("--require-approval", action="store_true")
    sp.add_argument("--poll", type=int, default=0)
    # list
    sp = s.add_parser("list", help="List sessions")
    sp.add_argument("--limit", type=int, default=20)
    # get
    sp = s.add_parser("get", help="Get session detail")
    sp.add_argument("session_id")
    # send
    sp = s.add_parser("send", help="Send message to session")
    sp.add_argument("session_id")
    sp.add_argument("message")
    # approve
    sp = s.add_parser("approve", help="Approve plan")
    sp.add_argument("session_id")
    # patch
    sp = s.add_parser("patch", help="Get patch from session")
    sp.add_argument("session_id")
    sp.add_argument("--output", "-o", help="Write patch to file")
    args = p.parse_args()
    if args.cmd == "create": cmd_create(args)
    elif args.cmd == "list": cmd_list(args)
    elif args.cmd == "get": cmd_get(args)
    elif args.cmd == "send": cmd_send(args)
    elif args.cmd == "approve": cmd_approve(args)
    elif args.cmd == "patch": cmd_patch(args)
    else: p.print_help()
