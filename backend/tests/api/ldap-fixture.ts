import { randomUUID } from "node:crypto";
import { Client } from "ldapts";

const OPENLDAP_IMAGE = "osixia/openldap:1.5.0@sha256:18742e9c449c9c1afe129d3f2f3ee15fb34cc43e5f940a20f3399728f41d7c28";
const LDAP_BASE_DN = "dc=example,dc=com";
const SERVICE_DN = `cn=admin,${LDAP_BASE_DN}`;
const SERVICE_PASSWORD = "service-secret";
const USER_PASSWORD = "ldap-pass";
const STARTUP_TIMEOUT_MS = 180_000;

export type LdapFixture = Readonly<{
  containerName: string;
  port: number;
}>;

type CommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

async function runDocker(args: readonly string[]): Promise<CommandResult> {
  try {
    const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode: await child.exited, stdout, stderr };
  } catch (error: unknown) {
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

async function docker(args: readonly string[]): Promise<string> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`docker ${args[0] ?? "command"} failed: ${detail}`);
  }
  return result.stdout;
}

async function removeContainer(containerName: string, options: { bestEffort?: boolean } = {}): Promise<void> {
  const result = await runDocker(["rm", "--force", containerName]);
  if (result.exitCode !== 0 && options.bestEffort !== true) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`docker rm failed: ${detail}`);
  }
}

async function containerStatus(containerName: string): Promise<string> {
  const result = await runDocker([
    "inspect",
    "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
    containerName,
  ]);
  return result.exitCode === 0 ? result.stdout.trim() : "";
}

async function containerLogs(containerName: string): Promise<string> {
  const result = await runDocker(["logs", containerName]);
  const logs = (result.stdout || result.stderr).trim();
  return logs.length > 12_000 ? logs.slice(-12_000) : logs;
}

async function waitForHealthy(containerName: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await containerStatus(containerName);
    if (status === "healthy") return;
    if (status === "exited" || status === "dead") {
      throw new Error(`OpenLDAP container stopped during startup:\n${await containerLogs(containerName)}`);
    }
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 1_000);
    });
  }
  throw new Error(`OpenLDAP container did not become healthy within ${STARTUP_TIMEOUT_MS / 1_000}s:\n${await containerLogs(containerName)}`);
}

async function mappedPort(containerName: string): Promise<number> {
  const output = await docker(["port", containerName, "389/tcp"]);
  const match = /:(\d+)\s*$/.exec(output.trim());
  if (match === null) throw new Error(`Docker did not report a host port for OpenLDAP: ${output.trim()}`);
  return Number(match[1]);
}

function clientFor(port: number): Client {
  return new Client({
    url: `ldap://127.0.0.1:${port}`,
    timeout: 10_000,
    connectTimeout: 10_000,
  });
}

async function verifyStartTls(port: number): Promise<void> {
  const client = clientFor(port);
  try {
    await client.startTLS({ rejectUnauthorized: false, minVersion: "TLSv1.2" });
    await client.bind(SERVICE_DN, SERVICE_PASSWORD);
    const result = await client.search(LDAP_BASE_DN, {
      scope: "base",
      filter: "(objectClass=*)",
      attributes: ["objectClass"],
    });
    if (result.searchEntries.length !== 1) {
      throw new Error(`StartTLS base search returned ${result.searchEntries.length} entries`);
    }
  } finally {
    await client.unbind().catch((): void => undefined);
  }
}

async function seedDirectory(port: number, usernames: readonly string[]): Promise<void> {
  const client = clientFor(port);
  try {
    await client.bind(SERVICE_DN, SERVICE_PASSWORD);
    const records = [
      ...usernames.map((username): Readonly<{ dn: string; uid: string; cn: string; mail: string }> => ({
        dn: `uid=${username},${LDAP_BASE_DN}`,
        uid: username,
        cn: username.charAt(0).toUpperCase() + username.slice(1),
        mail: `${username}@example.com`,
      })),
      {
        dn: `uid=duplicate,${LDAP_BASE_DN}`,
        uid: "duplicate",
        cn: "Duplicate",
        mail: "duplicate@example.com",
      },
      {
        dn: `uid=duplicate2,${LDAP_BASE_DN}`,
        uid: "duplicate",
        cn: "Duplicate 2",
        mail: "duplicate-2@example.com",
      },
    ];
    for (const record of records) {
      await client.add(record.dn, {
        objectClass: ["top", "person", "organizationalPerson", "inetOrgPerson"],
        uid: record.uid,
        cn: record.cn,
        sn: record.cn,
        mail: record.mail,
        userPassword: USER_PASSWORD,
      });
    }
    const duplicates = await client.search(LDAP_BASE_DN, {
      scope: "sub",
      filter: "(uid=duplicate)",
      attributes: ["uid", "mail", "cn"],
    });
    if (duplicates.searchEntries.length !== 2) {
      throw new Error(`OpenLDAP duplicate fixture returned ${duplicates.searchEntries.length} entries`);
    }
  } finally {
    await client.unbind().catch((): void => undefined);
  }
}

export async function startLdapFixture(usernames: readonly string[]): Promise<LdapFixture> {
  const containerName = `terrence-ldap-test-${process.pid}-${randomUUID().slice(0, 12)}`;
  let started = false;
  try {
    await docker([
      "run",
      "--detach",
      "--name",
      containerName,
      "--publish",
      "127.0.0.1::389",
      "--hostname",
      "ldap.local",
      "--env",
      "LDAP_DOMAIN=example.com",
      "--env",
      `LDAP_ADMIN_PASSWORD=${SERVICE_PASSWORD}`,
      "--env",
      "LDAP_CONFIG_PASSWORD=config-secret",
      "--env",
      "LDAP_TLS=true",
      "--env",
      "LDAP_TLS_ENFORCE=false",
      "--env",
      "LDAP_TLS_VERIFY_CLIENT=allow",
      "--health-cmd",
      `ldapsearch -x -ZZ -H ldap://localhost:389 -b ${LDAP_BASE_DN} -D ${SERVICE_DN} -w ${SERVICE_PASSWORD} -s base objectClass=* >/dev/null 2>&1 || exit 1`,
      "--health-interval=2s",
      "--health-timeout=4s",
      "--health-retries=90",
      "--health-start-period=5s",
      OPENLDAP_IMAGE,
      "--copy-service",
      "-l=debug",
    ]);
    started = true;
    await waitForHealthy(containerName);
    const port = await mappedPort(containerName);
    await verifyStartTls(port);
    await seedDirectory(port, usernames);
    return { containerName, port };
  } catch (error: unknown) {
    if (started) await removeContainer(containerName, { bestEffort: true });
    throw error;
  }
}

export async function stopLdapFixture(containerName: string): Promise<void> {
  await removeContainer(containerName);
}
