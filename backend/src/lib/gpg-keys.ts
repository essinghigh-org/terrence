import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type InspectedGpgKey =
  | Readonly<{ keyId: string; fingerprint: string }>
  | Readonly<{ error: string }>;

export async function inspectGpgPublicKey(asciiArmor: string): Promise<InspectedGpgKey> {
  if (
    asciiArmor.length > 1024 * 1024
    || !asciiArmor.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")
    || !asciiArmor.includes("-----END PGP PUBLIC KEY BLOCK-----")
  ) {
    return { error: "ascii-armor must contain a public PGP key no larger than 1 MiB" };
  }

  const home = await mkdtemp(join(tmpdir(), "terrence-gpg-"));
  try {
    const binary = process.env.GPG_BINARY_PATH ?? "gpg";
    const processHandle = Bun.spawn([
      binary,
      "--batch",
      "--homedir",
      home,
      "--no-options",
      "--with-colons",
      "--show-keys",
    ], {
      stdin: new Blob([asciiArmor]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    if (exitCode !== 0) {
      return { error: "ascii-armor is not a valid public PGP key" };
    }

    const records = stdout.split("\n").map((line): readonly string[] => line.split(":"));
    const publicKeys = records.filter((record): boolean => record[0] === "pub");
    const fingerprint = records.find((record): boolean => record[0] === "fpr")?.[9] ?? "";
    if (
      publicKeys.length !== 1
      || !["1", "17"].includes(publicKeys[0]?.[3] ?? "")
      || !/^[A-F0-9]{40,64}$/.test(fingerprint)
    ) {
      return { error: "ascii-armor must contain exactly one RSA or DSA public key" };
    }
    return { keyId: fingerprint.slice(-16), fingerprint };
  } catch {
    return { error: "Unable to inspect the public PGP key" };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
