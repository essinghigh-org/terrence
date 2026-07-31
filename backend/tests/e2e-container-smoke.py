#!/usr/bin/env python3
"""Container e2e: create workspace, upload config, plan+apply, verify isolation."""
import io
import json
import tarfile
import time
import urllib.request

BASE = "http://127.0.0.1:3200"
WS_ID = "cad75523-d488-4048-ae4c-f48774ebb4d2"
TOKEN = ""


def login():
    global TOKEN
    with urllib.request.urlopen(urllib.request.Request(BASE + "/api/v2/users/login", method="POST",
                                 data=json.dumps({"data": {"attributes": {"username": "smoke", "password": "smoke-password-123"}}}).encode(),
                                 headers={"Content-Type": "application/vnd.api+json"}), timeout=30) as resp:
        TOKEN = json.loads(resp.read().decode())["data"]["attributes"]["token"]


def api(method, path, body=None, raw=None, ctype=None):
    req = urllib.request.Request(BASE + path, method=method)
    if TOKEN:
        req.add_header("Authorization", "Bearer " + TOKEN)
    data = None
    if raw is not None:
        req.add_header("Content-Type", ctype or "application/octet-stream")
        data = raw
    elif body is not None:
        req.add_header("Content-Type", "application/vnd.api+json")
        data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req, data=data, timeout=120) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def build_config_tar():
    main_tf = """terraform {
  required_providers {
    null = { source = "hashicorp/null", version = "~> 3.2" }
  }
}
resource "null_resource" "probe" {
  provisioner "local-exec" {
    command = "id; echo PROBE_CWD=$(pwd); if cat /app/backend/storage/terrence.db > probe-stolen 2>/dev/null; then echo DB_READABLE_FAIL; else echo DB_DENIED_OK; fi; if ls /app/backend/storage > /dev/null 2>&1; then echo STORAGE_LISTABLE_FAIL; else echo STORAGE_DENIED_OK; fi"
  }
}
"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        data = main_tf.encode()
        info = tarfile.TarInfo("main.tf")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


login()
print("== create config version + upload ==")
s, raw = api("POST", f"/api/v2/workspaces/{WS_ID}/configuration-versions",
             {"data": {"type": "configuration-versions", "attributes": {"auto-queue-runs": False}}})
cv_id = json.loads(raw)["data"]["id"]
print("cv:", s, cv_id)
s, raw = api("PUT", f"/api/v2/configuration-versions/{cv_id}/upload", raw=build_config_tar())
print("upload:", s, raw[:80] if s != 200 else "ok")

print("== run with auto-apply ==")
s, raw = api("POST", "/api/v2/runs", {"data": {"type": "runs", "attributes": {"auto-apply": True, "message": "smoke apply"}, "relationships": {
    "workspace": {"data": {"type": "workspaces", "id": WS_ID}},
    "configuration-version": {"data": {"type": "configuration-versions", "id": cv_id}},
}}})
run_id = json.loads(raw)["data"]["id"]
print("run:", s, run_id)

status = ""
for _ in range(90):
    time.sleep(2)
    s, raw = api("GET", f"/api/v2/runs/{run_id}")
    status = json.loads(raw)["data"]["attributes"]["status"]
    if status not in ("pending", "plan_queued", "planning", "fetching",
                      "cost_estimating", "policy_checking", "confirmed",
                      "apply_queued", "applying"):
        break
print("final status:", status)

s, raw = api("GET", f"/api/v2/applies/apply-{run_id}")
apply = json.loads(raw)
log_url = apply["data"]["attributes"]["log-read-url"]
with urllib.request.urlopen(log_url, timeout=30) as resp:
    log_text = resp.read().decode()

print("=" * 60)
for marker in ["PROBE_CWD", "DB_DENIED_OK", "DB_READABLE_FAIL", "STORAGE_DENIED_OK",
               "STORAGE_LISTABLE_FAIL", "uid=", "Apply complete", "Error"]:
    if marker in log_text:
        line = [l for l in log_text.splitlines() if marker in l]
        print(f"  {marker}: {line[0].strip()[:150] if line else '(found)'}")
ok = ("DB_DENIED_OK" in log_text and "DB_READABLE_FAIL" not in log_text
      and "STORAGE_DENIED_OK" in log_text and "STORAGE_LISTABLE_FAIL" not in log_text
      and "Apply complete" in log_text)
print("ISOLATION-PASS (apply):", ok)
