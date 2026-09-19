import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { freeOperationalTestPort } from "../../src/lib/operational-test-profile";

const incomingDatabaseUrl = process.env["DATABASE_URL"] ?? "";
const postgres = /^postgres(?:ql)?:\/\//i.test(incomingDatabaseUrl);
const haTest = postgres ? test : test.skip;
const BACKEND_DIR = new URL("../..", import.meta.url).pathname;

const decoder = new TextDecoder();

type Replica = Readonly<{
  id: string;
  port: number;
  systemPort: number;
  proc: Bun.Subprocess;
  logPath: string;
}>;

type LeaseRow = Readonly<{
  owner_node_id: string;
  fencing_epoch: number | bigint | string;
  expires_at: number | bigint | string;
  active: boolean;
}>;

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolve): void => {
    setTimeout(resolve, milliseconds);
  });
};

function backendEnvironment(
  databaseUrl: string,
  storageDir: string,
  nodeId: string,
  port: number,
  systemPort: number,
  publicUrl: string,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("TERRENCE_E2E_"),
    ),
  );
  return {
    ...inherited,
    NODE_ENV: "production",
    DATABASE_URL: databaseUrl,
    STORAGE_DIR: storageDir,
    TERRENCE_HA_ENABLED: "true",
    TERRENCE_NODE_ID: nodeId,
    PUBLIC_URL: publicUrl,
    ENCRYPTION_PASSWORD: "ha-e2e-encryption-password-123456",
    TERRENCE_TOKEN_HASH_SECRET: "ha-e2e-token-hash-secret-1234567890",
    SIGNED_URL_SECRET: "ha-e2e-signed-url-secret-1234567890",
    ADMIN_PASSWORD: "ha-e2e-admin-password-123456",
    TERRENCE_RUN_SANDBOX: "false",
    TERRENCE_DISABLE_RESTART: "1",
    TERRENCE_DISABLE_WORKER: "0",
    PORT: String(port),
    SYSTEM_API_PORT: String(systemPort),
  };
}

async function startReplica(
  id: string,
  databaseUrl: string,
  storageDir: string,
  publicUrl: string,
  workDir: string,
): Promise<Replica> {
  const [port, systemPort] = await Promise.all([freeOperationalTestPort(), freeOperationalTestPort()]);
  const logPath = join(workDir, `${id}.log`);
  const logFd = openSync(logPath, "w", 0o600);
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["bun", "index.ts"], {
      cwd: BACKEND_DIR,
      env: backendEnvironment(databaseUrl, storageDir, id, port, systemPort, publicUrl),
      stdout: logFd,
      stderr: logFd,
    });
  } finally {
    closeSync(logFd);
  }
  return { id, port, systemPort, proc, logPath };
}

async function waitForHealth(replica: Replica, attempts = 160): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${replica.port}/healthz`);
      if (response.ok) return;
    } catch {
      // Startup races the first few probes.
    }
    if (replica.proc.exitCode !== null) break;
    await sleep(125);
  }
  const tail = (await readFile(replica.logPath, "utf8").catch(() => "")).split("\n").slice(-80).join("\n");
  throw new Error(`HA replica ${replica.id} did not become healthy\n${tail}`);
}

async function terminate(replica: Replica, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (replica.proc.exitCode !== null) return;
  replica.proc.kill(signal);
  await Promise.race([replica.proc.exited.then((): void => undefined), sleep(5_000)]);
  if (replica.proc.exitCode === null) {
    replica.proc.kill("SIGKILL");
    await replica.proc.exited;
  }
}

async function leaseRow(sql: Bun.SQL): Promise<LeaseRow | undefined> {
  const rows = (await sql.unsafe(
    "SELECT owner_node_id, fencing_epoch, expires_at, " +
      "expires_at > CAST(EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS BIGINT) AS active " +
      "FROM control_plane_leases WHERE name = 'scheduler'",
  )) as unknown as LeaseRow[];
  return rows[0];
}

function numeric(value: number | bigint | string): number {
  return Number(value);
}

async function bootstrapAdminToken(replica: Replica): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${replica.port}/api/v2/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: { attributes: { username: "admin", password: "ha-e2e-admin-password-123456" } },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data?: { attributes?: { token?: unknown } } };
  const token = body.data?.attributes?.token;
  if (typeof token !== "string" || token === "") throw new Error("bootstrap admin login did not return a token");
  return token;
}

async function openEventStream(replica: Replica, token: string): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await fetch(`http://127.0.0.1:${replica.port}/api/v2/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("SSE response did not expose a body");
  const first = await Promise.race([
    reader.read(),
    sleep(3_000).then(() => ({ done: false as const, value: undefined })),
  ]);
  expect(first.value).toBeDefined();
  if (first.value === undefined) throw new Error("SSE stream did not emit its connected frame");
  expect(decoder.decode(first.value)).toContain("event: connected");
  return reader;
}

async function expectStreamClosed(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const result = await Promise.race([
    reader.read(),
    sleep(5_000).then(() => ({ done: false as const, value: undefined })),
  ]);
  expect(result.done).toBe(true);
  await reader.cancel().catch((): void => undefined);
  reader.releaseLock();
}

haTest(
  "three PostgreSQL replicas serialize fresh boot and fail over the fenced coordinator",
  async () => {
    const databaseName = `terrence_ha_${crypto.randomUUID().replaceAll("-", "")}`;
    const root = await mkdtemp(join(tmpdir(), "terrence-ha-e2e-"));
    const storageDir = join(root, "storage");
    const logsDir = join(root, "logs");
    await Promise.all([mkdir(join(storageDir, "binaries"), { recursive: true }), mkdir(logsDir, { recursive: true })]);

    const admin = new Bun.SQL(incomingDatabaseUrl);
    const target = new URL(incomingDatabaseUrl);
    target.pathname = `/${databaseName}`;
    const databaseUrl = target.toString();
    const cluster = new Bun.SQL(databaseUrl);
    const replicas: Replica[] = [];

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);

      // Allocate the advertised URL independently of the per-replica listeners:
      // PUBLIC_URL is cluster identity and must be identical on every node.
      const publicPort = await freeOperationalTestPort();
      const publicUrl = `http://127.0.0.1:${publicPort}`;

      const started = await Promise.all(
        ["ha-node-a", "ha-node-b", "ha-node-c"].map((id) =>
          startReplica(id, databaseUrl, storageDir, publicUrl, logsDir),
        ),
      );
      replicas.push(...started);
      await Promise.all(replicas.map((replica) => waitForHealth(replica)));

      let initialLease: LeaseRow | undefined;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        initialLease = await leaseRow(cluster);
        if (initialLease?.active === true) break;
        await sleep(125);
      }
      expect(initialLease).toBeDefined();
      if (initialLease === undefined) throw new Error("expected an elected coordinator");
      expect(numeric(initialLease.fencing_epoch)).toBe(1);

      let nodes: { id: string; role: string; coordinator_epoch: number | bigint | string | null }[] = [];
      for (let attempt = 0; attempt < 80; attempt += 1) {
        nodes = (await cluster.unsafe(
          "SELECT id, role, coordinator_epoch FROM control_plane_nodes WHERE id LIKE 'ha-node-%' ORDER BY id",
        )) as unknown as typeof nodes;
        if (nodes.length === 3 && nodes.filter((node) => node.role === "leader").length === 1) break;
        await sleep(125);
      }
      expect(nodes).toHaveLength(3);
      expect(nodes.filter((node) => node.role === "leader")).toHaveLength(1);
      expect(nodes.filter((node) => node.role === "follower")).toHaveLength(2);
      expect(nodes.find((node) => node.role === "leader")?.id).toBe(initialLease.owner_node_id);

      // The bootstrap account intentionally starts behind a password-change
      // gate. This isolated database bypasses that unrelated UX requirement so
      // the HA test can exercise normal authenticated routes without changing
      // credentials as part of the test itself.
      await cluster.unsafe("UPDATE users SET must_change_password = false WHERE username = 'admin'");

      // Prove the PostgreSQL event bridge, not just process-local fan-out:
      // authenticate to node A, keep its SSE stream open, then mutate that
      // account through node B. Node B publishes authz.changed; node A must
      // receive the durable event through LISTEN/NOTIFY and close its stream.
      const eventReceiver = replicas[0];
      const eventPublisher = replicas[1];
      if (eventReceiver === undefined || eventPublisher === undefined) throw new Error("expected two HA replicas");
      const adminToken = await bootstrapAdminToken(eventReceiver);
      const adminRows = (await cluster.unsafe("SELECT id FROM users WHERE username = 'admin'")) as unknown as {
        id: string;
      }[];
      const adminId = adminRows[0]?.id;
      if (adminId === undefined) throw new Error("bootstrap admin row is missing");
      const eventReader = await openEventStream(eventReceiver, adminToken);

      const mutation = await fetch(
        `http://127.0.0.1:${eventPublisher.port}/api/v2/admin/users/${encodeURIComponent(adminId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/vnd.api+json",
          },
          body: JSON.stringify({
            data: {
              type: "users",
              id: adminId,
              attributes: { email: "ha-cross-replica@example.com" },
            },
          }),
        },
      );
      expect(mutation.status).toBe(200);
      await expectStreamClosed(eventReader);

      let eventOrigin: string | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const eventRows = (await cluster.unsafe(
          "SELECT origin_node_id FROM control_events WHERE topic = 'authz.changed' ORDER BY created_at DESC, id DESC LIMIT 1",
        )) as unknown as { origin_node_id: string }[];
        eventOrigin = eventRows[0]?.origin_node_id;
        if (eventOrigin !== undefined) break;
        await sleep(50);
      }
      expect(eventOrigin).toBe(eventPublisher.id);

      // A live node identity is exclusive even though the coordinator election
      // itself is fenced by a separate per-process instance token.
      const duplicate = await startReplica(initialLease.owner_node_id, databaseUrl, storageDir, publicUrl, logsDir);
      replicas.push(duplicate);
      await Promise.race([duplicate.proc.exited, sleep(10_000)]);
      expect(duplicate.proc.exitCode).not.toBeNull();
      expect(duplicate.proc.exitCode).not.toBe(0);
      const duplicateLog = await readFile(duplicate.logPath, "utf8");
      expect(duplicateLog).toContain("already registered by another live control-plane instance");

      const leader = replicas.find(
        (replica): boolean => replica.id === initialLease?.owner_node_id && replica.proc.exitCode === null,
      );
      expect(leader).toBeDefined();
      if (leader === undefined) throw new Error("elected coordinator process not found");
      leader.proc.kill("SIGKILL");
      await leader.proc.exited;

      let replacement: LeaseRow | undefined;
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const candidate = await leaseRow(cluster);
        if (
          candidate !== undefined &&
          candidate.owner_node_id !== initialLease.owner_node_id &&
          numeric(candidate.fencing_epoch) >= 2 &&
          candidate.active
        ) {
          replacement = candidate;
          break;
        }
        await sleep(125);
      }
      expect(replacement).toBeDefined();
      if (replacement === undefined) throw new Error("expected coordinator failover");
      expect(replacement.owner_node_id).not.toBe(initialLease.owner_node_id);
      expect(numeric(replacement.fencing_epoch)).toBeGreaterThanOrEqual(2);

      const survivors = replicas.filter(
        (replica): boolean =>
          replica.id !== initialLease.owner_node_id &&
          replica.proc.exitCode === null &&
          ["ha-node-a", "ha-node-b", "ha-node-c"].includes(replica.id),
      );
      expect(survivors).toHaveLength(2);
      for (const survivor of survivors) {
        const response = await fetch(`http://127.0.0.1:${survivor.port}/healthz`);
        expect(response.ok).toBe(true);
      }
    } finally {
      await Promise.all(replicas.map((replica) => terminate(replica).catch((): void => undefined)));
      await cluster.close().catch((): void => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch((): void => undefined);
      await admin.close().catch((): void => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  75_000,
);
