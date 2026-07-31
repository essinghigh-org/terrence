#!/usr/bin/env python3
"""Fetch + inspect the plan log for the container smoke run."""
import json
import urllib.request

BASE = "http://127.0.0.1:3200"
TOKEN = ""
RUN_ID = "d01d89e7-b98c-4264-9ae6-097bac58e4d1"

with urllib.request.urlopen(urllib.request.Request(BASE + "/api/v2/users/login", method="POST",
                             data=json.dumps({"data": {"attributes": {"username": "smoke", "password": "smoke-password-123"}}}).encode(),
                             headers={"Content-Type": "application/vnd.api+json"}), timeout=30) as resp:
    TOKEN = json.loads(resp.read().decode())["data"]["attributes"]["token"]

with urllib.request.urlopen(urllib.request.Request(BASE + f"/api/v2/runs/{RUN_ID}",
                             headers={"Authorization": "Bearer " + TOKEN}), timeout=30) as resp:
    run = json.loads(resp.read().decode())

attrs = run["data"]["attributes"]
print("run status:", attrs["status"])
print("has plan log-read-url:", "plan" in attrs)
log_url = attrs["plan"]["log-read-url"]
print("log url:", log_url)

with urllib.request.urlopen(log_url, timeout=30) as resp:
    log_text = resp.read().decode()

print("=" * 60)
print("log length:", len(log_text))
for marker in ["PROBE_CWD", "DB_DENIED_OK", "DB_READABLE_FAIL", "STORAGE_DENIED_OK", "STORAGE_LISTABLE_FAIL", "uid=", "Error", "Apply complete"]:
    if marker in log_text:
        line = [l for l in log_text.splitlines() if marker in l]
        print(f"  {marker}: {line[0].strip()[:140] if line else '(found)'}")

print("=" * 60)
print("PASS:", "DB_DENIED_OK" in log_text and "DB_READABLE_FAIL" not in log_text and "STORAGE_DENIED_OK" in log_text)
