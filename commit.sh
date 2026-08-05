#!/bin/bash
export HOME=/root
cd /root/terrence
git commit -m "feat: full hashicorp/tfe v0.79.0 provider compatibility

- Org-scoped standalone policies: POST/GET /organizations/:org/policies,
  PUT /policies/:id/upload, GET /policies/:id/download
- Run tasks: dual /run-tasks + /tasks paths, correct JSON:API types
  (\"tasks\"/\"workspace-tasks\"), org relationship, workspace-task attach
- Policy sets: full relationships on GET/list, create attach for policy_ids,
  POST/DELETE /relationships/policies
- Teams: organization-access accepts all 19 provider keys + string keys
  (visibility, sso-team-id), PATCH extracts from org-access object
- Workspace outputs: ?include=outputs returns workspace-outputs for tfe_outputs
- Sentinel binary installed for policy evaluation
- E2E hygiene: backend temp dir cleanup (~300MB/run) prevents tmpfs OOM
- Both terraform & tofu E2E pass (33 resources, 26 data sources)
- Full suite: 645 pass, 0 fail"