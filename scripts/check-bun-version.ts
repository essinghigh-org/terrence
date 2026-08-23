import packageJson from "../package.json";

const rawVersion = typeof packageJson.packageManager === "string" ? packageJson.packageManager : "bun@1.4.0";
const expectedVersion = rawVersion.replace(/^bun@/, "");
const currentVersion = Bun.version;

if (currentVersion !== expectedVersion) {
  console.error(
    `Bun version mismatch: expected ${expectedVersion} (from package.json packageManager), but running on ${currentVersion}`,
  );
  process.exit(1);
}

console.log(`Bun version OK: ${currentVersion}`);
