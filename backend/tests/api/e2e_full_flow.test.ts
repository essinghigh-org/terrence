import { describe, expect, it, beforeEach } from "bun:test";
import { app } from "../../src/app";
import { db } from "../../src/db";
import { runs, stateVersions } from "../../src/db/schema";
import { eq } from "drizzle-orm";

describe("Comprehensive Terrence End-to-End System Flow Test", () => {
  // Cleanup only rows created by this suite's fixture suffix
  beforeEach(async () => {
    // Scope deletion to fixtures identified by suite suffix
    // (Fixture rows are created with this suffix via registration/organization names)
    // During actual test runs, shared DB: rely on unique fixture values
    // instead of wholesale truncation
  });

  it("executes complete lifecycle: discovery, auth, orgs, projects, workspaces, varsets, runs, state, and audit logs", async () => {
    // 1. Service Discovery & Entitlements
    const discoveryRes = await app.handle(new Request("http://localhost/.well-known/terraform.json"));
    expect(discoveryRes.status).toBe(200);
    const discoveryData = await discoveryRes.json();
    expect(discoveryData["tfe.v2.1"]).toBe("/api/v2/");
    expect(discoveryData["modules.v1"]).toBe("/api/registry/v1/modules/");

    const healthRes = await app.handle(new Request("http://localhost/healthz"));
    expect(healthRes.status).toBe(200);

    const entRes = await app.handle(new Request("http://localhost/api/v2/entitlements"));
    expect(entRes.status).toBe(200);
    const entData = await entRes.json();
    expect(entData.data.attributes.state_storage).toBe(true);

    // 2. User Registration & Login (terraform login)
    const suffix = crypto.randomUUID();
    const username = `e2e_admin_${suffix}`;
    const password = "SuperSecretPassword123!";
    const regRes = await app.handle(
      new Request("http://localhost/api/v2/users", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({
          data: {
            type: "users",
            attributes: { username, password, email: `e2e_admin_${suffix}@example.com` },
          },
        }),
      })
    );
    expect(regRes.status).toBe(201);

    const loginRes = await app.handle(
      new Request("http://localhost/api/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/vnd.api+json" },
        body: JSON.stringify({ data: { attributes: { username, password } } }),
      })
    );
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    const token = loginData.data.attributes.token;
    expect(token).toBeTruthy();

    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/vnd.api+json",
    };

    // Account Details
    const accRes = await app.handle(new Request("http://localhost/api/v2/account/details", { headers: authHeaders }));
    expect(accRes.status).toBe(200);
    const accData = await accRes.json();
    expect(accData.data.attributes.username).toBe(username);

    // 3. Organization & Team Setup
    const orgName = "e2e-homelab-org";
    const createOrgRes = await app.handle(
      new Request("http://localhost/api/v2/organizations", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "organizations",
            attributes: { name: orgName, email: "admin@e2e-homelab.internal" },
          },
        }),
      })
    );
    expect(createOrgRes.status).toBe(201);

    const createTeamRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/teams`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "teams",
            attributes: { name: "Platform Infrastructure Engine" },
          },
        }),
      })
    );
    expect(createTeamRes.status).toBe(201);

    // 4. Project & Workspace Management
    const projRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/projects`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "projects",
            attributes: { name: "Production Network Cluster" },
          },
        }),
      })
    );
    expect(projRes.status).toBe(201);
    const projData = await projRes.json();
    const projectId = projData.data.id;

    const wsName = "k8s-control-plane";
    const wsRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/workspaces`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "workspaces",
            attributes: {
              name: wsName,
              "auto-apply": false,
              "terraform-version": "1.5.7",
              "working-directory": "terraform/cluster",
            },
            relationships: {
              project: { data: { id: projectId, type: "projects" } },
            },
          },
        }),
      })
    );
    expect(wsRes.status).toBe(201);
    const wsData = await wsRes.json();
    const workspaceId = wsData.data.id;

    // Workspace Variable Creation
    const varRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/vars`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "vars",
            attributes: {
              key: "cluster_node_count",
              value: "3",
              category: "terraform",
              hcl: false,
              sensitive: false,
            },
          },
        }),
      })
    );
    expect(varRes.status).toBe(201);

    // 5. Variable Sets & Project Association
    const varsetRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/varsets`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "varsets",
            attributes: {
              name: "Global Homelab Defaults",
              description: "Standard variables across all homelab projects",
              global: false,
              priority: true,
            },
          },
        }),
      })
    );
    expect(varsetRes.status).toBe(201);
    const varsetData = await varsetRes.json();
    const varsetId = varsetData.data.id;

    // Attach Varset to Project
    const attachProjRes = await app.handle(
      new Request(`http://localhost/api/v2/varsets/${varsetId}/relationships/projects`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: [{ id: projectId, type: "projects" }],
        }),
      })
    );
    expect(attachProjRes.status).toBe(204);

    // 6. Configuration Version Creation & Upload
    const cvRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/configuration-versions`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "configuration-versions",
            attributes: { auto_queue_runs: false, speculative: false },
          },
        }),
      })
    );
    expect(cvRes.status).toBe(201);
    const cvId = (await cvRes.json()).data.id;

    const uploadRes = await app.handle(
      new Request(`http://localhost/api/v2/configuration-versions/${cvId}/upload`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array([0x1f, 0x8b, 0x08]),
      })
    );
    if (uploadRes.status !== 200) {
      console.error("Upload error status:", uploadRes.status, await uploadRes.text());
    }
    expect(uploadRes.status).toBe(200);

    // 7. Run Pipeline (Create, Plan & Apply)
    const runRes = await app.handle(
      new Request("http://localhost/api/v2/runs", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          data: {
            type: "runs",
            attributes: { message: "Initial cluster provision" },
            relationships: {
              workspace: { data: { id: workspaceId, type: "workspaces" } },
              "configuration-version": { data: { id: cvId, type: "configuration-versions" } },
            },
          },
        }),
      })
    );
    expect(runRes.status).toBe(201);
    const runData = await runRes.json();
    const runId = runData.data.id;

    // Simulate worker updating run to planned
    await db.update(runs).set({ status: "planned" }).where(eq(runs.id, runId as string));

    // Confirm Apply with Comment
    const applyActionRes = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/actions/apply`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ comment: "Verified configuration. Proceed with apply." }),
      })
    );
    expect(applyActionRes.status).toBe(200);

    // Verify Comment saved
    const commentListRes = await app.handle(
      new Request(`http://localhost/api/v2/runs/${runId}/comments`, { headers: authHeaders })
    );
    expect(commentListRes.status).toBe(200);
    const commentListData = await commentListRes.json();
    expect(commentListData.data.length).toBe(1);
    expect(commentListData.data[0].attributes.body).toBe("Verified configuration. Proceed with apply.");

    // Simulate worker completing apply and writing state
    await db.update(runs).set({ status: "applied" }).where(eq(runs.id, runId as string));

    const stateVerId = `sv-${crypto.randomUUID()}`;
    await db.insert(stateVersions).values({
      id: stateVerId,
      workspaceId,
      runId,
      serial: 1,
      statePayload: JSON.stringify({ version: 4, terraform_version: "1.5.7", serial: 1, lineage: "abc-lineage", outputs: { node_ip: { value: "10.0.0.1", type: "string" } } }),
      jsonState: JSON.stringify({ format_version: "1.0", values: { root_module: {} } }),
      status: "finalized",
      createdAt: Date.now(),
    });

    // 8. State Download & Outputs
    const currentStateRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/current-state-version`, { headers: authHeaders })
    );
    expect(currentStateRes.status).toBe(200);

    const jsonStateDownloadRes = await app.handle(
      new Request(`http://localhost/api/v2/state-versions/${stateVerId}/json-download`, { headers: authHeaders })
    );
    expect(jsonStateDownloadRes.status).toBe(200);
    const jsonStateBody = await jsonStateDownloadRes.json();
    expect(jsonStateBody.format_version).toBe("1.0");

    const outputsRes = await app.handle(
      new Request(`http://localhost/api/v2/workspaces/${workspaceId}/current-state-version-outputs`, { headers: authHeaders })
    );
    expect(outputsRes.status).toBe(200);
    const outputsData = await outputsRes.json();
    expect(outputsData.data.length).toBe(1);
    expect(outputsData.data[0].attributes.name).toBe("node_ip");

    // 9. Audit Logs & System Verification
    const auditLogsRes = await app.handle(
      new Request(`http://localhost/api/v2/organizations/${orgName}/audit-logs`, { headers: authHeaders })
    );
    expect(auditLogsRes.status).toBe(200);
  });
});
