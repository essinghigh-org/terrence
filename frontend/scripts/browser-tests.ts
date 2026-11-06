import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WEBVIEW_STARTUP_TITLE,
  WEBVIEW_STARTUP_URL,
  withWebViewDeadline,
} from "../tests/browser/helpers/webview-lifecycle";

const NATIVE_STARTUP_TIMEOUT_MS = 30_000;
const browserDirectory = resolve(import.meta.dir, "../tests/browser");
type OwnedProcess = Readonly<{
  pid: number;
  exitCode: number | null;
  exited: Promise<number>;
  kill: (signal: NodeJS.Signals) => void;
}>;

function signalOwnedGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function stopOwnedGroup(pid: number | undefined, exited: () => Promise<number>, grace = 1500): Promise<void> {
  if (pid === undefined) return;
  signalOwnedGroup(pid, "SIGTERM");
  // Give nested cold-start supervisors time to clean their own browser/profile.
  const deadline = performance.now() + grace;
  while (performance.now() < deadline) {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") break;
      throw error;
    }
    await Bun.sleep(25);
  }
  signalOwnedGroup(pid, "SIGKILL");
  await exited();
}

function chromeExecutable(): string {
  const configured = process.env["BUN_CHROME_PATH"];
  if (configured !== undefined && configured !== "") return configured;
  for (const name of ["google-chrome-stable", "google-chrome", "chromium-browser", "chromium", "chrome"]) {
    const executable = Bun.which(name);
    if (executable !== null) return executable;
  }
  throw new Error("Chrome is required for browser tests; set BUN_CHROME_PATH to its executable");
}

function chromeEndpoint(content: string): Readonly<{ port: number; path: string }> {
  const [portText, path] = content.trim().split("\n");
  const port = Number(portText);
  if (
    path === undefined ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)
  )
    throw new Error("Chrome wrote an invalid DevTools endpoint");
  return { port, path };
}

function readinessPending(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "ENOENT") ||
      error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      error instanceof TypeError)
  );
}

async function waitForChrome(exited: () => number | null, directory: string, startedAt: number): Promise<string> {
  const deadline = startedAt + NATIVE_STARTUP_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const exitCode = exited();
    if (exitCode !== null) throw new Error(`Chrome exited before DevTools readiness (exit ${exitCode})`);
    try {
      const { port, path } = chromeEndpoint(await readFile(join(directory, "DevToolsActivePort"), "utf8"));
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - performance.now()))),
      });
      if (response.ok) {
        return `ws://127.0.0.1:${port}${path}`;
      }
    } catch (error) {
      if (!readinessPending(error)) throw error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Chrome process did not expose DevTools within ${NATIVE_STARTUP_TIMEOUT_MS}ms`);
}

async function main(): Promise<number> {
  // Parent cleanup also owns nested cold-start profiles if cancellation interrupts their supervisors.
  const directory = await mkdtemp(join(process.env["TERRENCE_TEST_BROWSER_ROOT"] ?? tmpdir(), "terrence-browser-"));
  let chrome: OwnedProcess | undefined;
  let tests: OwnedProcess | undefined;
  let interrupted: number | undefined;
  const stop = (): void => {
    signalOwnedGroup(tests?.pid, "SIGTERM");
    signalOwnedGroup(chrome?.pid, "SIGTERM");
  };
  const forceStop = (): void => {
    signalOwnedGroup(tests?.pid, "SIGKILL");
    signalOwnedGroup(chrome?.pid, "SIGKILL");
  };
  const interrupt = (): void => {
    interrupted = 130;
    stop();
  };
  const terminate = (): void => {
    interrupted = 143;
    stop();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  process.once("exit", forceStop);
  try {
    const executable = chromeExecutable();
    console.info(`[browser] starting owned Chrome: ${executable}`);
    const startedAt = performance.now();
    chrome = Bun.spawn(
      [
        executable,
        `--user-data-dir=${directory}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--headless",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-startup-window",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-ipc-flooding-protection",
        "--disable-dev-shm-usage",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "inherit", detached: true },
    );
    let chromeExit: number | null = null;
    void chrome.exited.then((exitCode): void => {
      chromeExit = exitCode;
    });
    const endpoint = await waitForChrome((): number | null => chromeExit, directory, startedAt);
    const startup = new Bun.WebView({ backend: { type: "chrome", url: endpoint } });
    try {
      await withWebViewDeadline(
        async (): Promise<void> => {
          await startup.navigate(WEBVIEW_STARTUP_URL);
          if ((await startup.evaluate("document.title")) !== WEBVIEW_STARTUP_TITLE)
            throw new Error("Owned Chrome did not complete its native readiness handshake");
        },
        "owned Chrome native readiness",
        Math.max(1, NATIVE_STARTUP_TIMEOUT_MS - (performance.now() - startedAt)),
        (): void => {
          startup.close();
        },
      );
    } finally {
      startup.close();
    }
    console.info(`[browser] owned Chrome ready after ${Math.round(performance.now() - startedAt)}ms`);
    const args = process.argv.slice(2);
    const testArgs =
      args[0] === "--axe"
        ? [...new Bun.Glob("accessibility-*.test.ts").scanSync({ cwd: browserDirectory })].map((file): string =>
            join(browserDirectory, file),
          )
        : args;
    if (args[0] === "--axe" && testArgs.length === 0) throw new Error("No accessibility browser tests were found");
    const command =
      args[0] === "--cold-start"
        ? [process.execPath, join(browserDirectory, "helpers/cold-start.ts")]
        : [process.execPath, "test", ...(testArgs.length === 0 ? ["."] : testArgs)];
    tests = Bun.spawn(command, {
      cwd: browserDirectory,
      env: { ...process.env, TERRENCE_TEST_CHROME_URL: endpoint, TERRENCE_TEST_BROWSER_ROOT: directory },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
    const exitCode = await tests.exited;
    return interrupted ?? exitCode;
  } catch (error) {
    if (interrupted !== undefined) return interrupted;
    throw error;
  } finally {
    await Promise.all([
      stopOwnedGroup(tests?.pid, async (): Promise<number> => (tests === undefined ? 0 : await tests.exited), 3000),
      stopOwnedGroup(chrome?.pid, async (): Promise<number> => (chrome === undefined ? 0 : await chrome.exited)),
    ]);
    await rm(directory, { recursive: true, force: true });
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("exit", forceStop);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
