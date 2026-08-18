import { join } from "node:path";

export const registryModuleFixture = join(import.meta.dir, "fixtures/registry-module");

export async function makeRegistryModuleArchive(destination: string, source = registryModuleFixture): Promise<void> {
  const tar = Bun.spawn(["tar", "-czf", destination, "-C", source, "."], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr || "Could not create registry module fixture archive");
}
