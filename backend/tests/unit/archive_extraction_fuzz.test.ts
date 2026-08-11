/**
 * archive_extraction_fuzz.test.ts — fuzz tests for the archive-extraction
 * guards (kanban 22.6).
 *
 * The extraction pipeline (binaryManager zip install + worker tar config
 * extraction) defends two invariants:
 *
 *   1. No archive member may escape the extraction root (absolute paths,
 *      drive letters, `..` traversal segments).
 *   2. No archive member may be a link or special file (symlink, hard link,
 *      device node, fifo, socket), and no extra member may ride along in a
 *      binary package.
 *
 * The guards are pure predicates, so this suite fuzzes them directly with a
 * seeded PRNG over path-shaped strings plus curated adversarial corpora,
 * and asserts the predicates never disagree with the spec they encode.
 */
import { describe, expect, test } from "bun:test";
import { unexpectedZipMembers, zipEntryEscapes } from "../../src/binaryManager";
import { tarMemberIsForbiddenSpecial, tarMemberPathUnsafe } from "../../src/worker";

/** Deterministic mulberry32 PRNG so fuzz runs are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATH_ALPHABET = ["a", "b", "c", "0", "9", ".", "/", "\\", ":", "-", "_", " ", ".."];

function randomPath(rand: () => number, maxLen = 24): string {
  const len = Math.floor(rand() * (maxLen + 1));
  let out = "";
  for (let i = 0; i < len; i++) {
    out += PATH_ALPHABET[Math.floor(rand() * PATH_ALPHABET.length)]!;
  }
  return out;
}

/** The exact spec zipEntryEscapes is supposed to implement. */
function zipEscapesSpec(entry: string): boolean {
  const normalized = entry.replaceAll("\\", "/");
  return normalized.startsWith("/")
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split("/").some((segment): boolean => segment === "..");
}

describe("zipEntryEscapes (binaryManager)", () => {
  test("curated adversarial corpus is fully rejected", () => {
    const malicious = [
      "../../etc/passwd",
      "/etc/passwd",
      "//etc/passwd",
      "C:/windows/system32",
      "c:\\windows\\system32",
      "Z:evil.exe",
      "..",
      "a/../b",
      "a\\..\\b",
      "../tofu",
      "tofu/../../x",
      "a/b/../../../c",
      "./../x",
    ];
    for (const entry of malicious) {
      expect(zipEntryEscapes(entry), `expected ${JSON.stringify(entry)} to escape`).toBe(true);
    }
  });

  test("curated safe corpus is fully accepted", () => {
    const safe = [
      "tofu",
      "terraform",
      "./tofu",
      ".\\tofu",
      "a/b/c",
      "a/b/c.txt",
      "a.b",
      "a..b", // single segment, not a traversal
      "..hidden",
      "a/.../b",
      "0/1/2",
      "-",
      "",
    ];
    for (const entry of safe) {
      expect(zipEntryEscapes(entry), `expected ${JSON.stringify(entry)} to be safe`).toBe(false);
    }
  });

  test("fuzz: implementation never disagrees with the spec", () => {
    const rand = mulberry32(0x2a62);
    for (let i = 0; i < 20_000; i++) {
      const entry = randomPath(rand);
      expect(zipEntryEscapes(entry)).toBe(zipEscapesSpec(entry));
    }
  });

  test("fuzz: backslash variants classify identically to forward-slash forms", () => {
    const rand = mulberry32(0xb2c5);
    for (let i = 0; i < 10_000; i++) {
      const entry = randomPath(rand);
      // genuine backslash variant: every forward slash becomes a backslash.
      // The guard normalizes backslashes to slashes before classifying, so
      // both forms must agree.
      const flipped = entry.replaceAll("/", "\\");
      expect(zipEntryEscapes(entry)).toBe(zipEntryEscapes(flipped));
    }
  });
});

describe("unexpectedZipMembers (binaryManager)", () => {
  test("exact expected member is never flagged, everything else is", () => {
    const entries = ["tofu", "./tofu", ".\\tofu", "terraform", "tofu/", "tofu.exe", "TOFU", "", "a/tofu", "././tofu"];
    const unexpected = unexpectedZipMembers(entries, "tofu");
    // only one leading "./" is stripped, so "././tofu" stays unexpected
    expect(unexpected.sort()).toEqual(["", "TOFU", "a/tofu", "terraform", "tofu.exe", "tofu/", "././tofu"].sort());
  });

  test("property: classification equals normalize-then-compare", () => {
    const normalize = (entry: string): string => entry.replaceAll("\\", "/").replace(/^\.\//, "");
    const rand = mulberry32(0xbeef);
    for (let i = 0; i < 5000; i++) {
      const bin = randomPath(rand, 8) || "tofu";
      const count = Math.floor(rand() * 8);
      const entries = Array.from({ length: count }, () => randomPath(rand, 12));
      const expected = entries.filter((e) => normalize(e) !== bin);
      expect(unexpectedZipMembers(entries, bin).sort()).toEqual(expected.sort());
    }
  });

  test("property: a member whose normalized form equals the binary is never unexpected", () => {
    const rand = mulberry32(0xfeed);
    const normalize = (entry: string): string => entry.replaceAll("\\", "/").replace(/^\.\//, "");
    const bin = "tofu";
    for (let i = 0; i < 2000; i++) {
      const members = [bin, ...Array.from({ length: Math.floor(rand() * 4) }, () => randomPath(rand, 8))];
      const unexpected = unexpectedZipMembers(members, bin);
      // no flagged member may normalize to the expected binary
      expect(unexpected.some((m) => normalize(m) === bin)).toBe(false);
      // the bare binary and its single './'-prefixed/backslash forms are kept
      for (const form of [bin, "./tofu", ".\\tofu"]) {
        expect(unexpectedZipMembers([form], bin)).toEqual([]);
      }
    }
    // pinned quirk: a './'-prefixed expectedBinary can never match, because
    // normalize() strips one leading "./" from members but not from the
    // expected name — callers pass the bare name, so this is informational.
    expect(unexpectedZipMembers(["./tofu"], "./tofu")).toEqual(["./tofu"]);
  });
});

describe("tarMemberPathUnsafe (worker)", () => {
  test("curated adversarial corpus is fully rejected", () => {
    const malicious = [
      "/etc/passwd",
      "//x",
      "..",
      "../x",
      "a/../b",
      "a\\..\\b",
      "a/..",
      "a/../..",
      "....",
      "a..b", // substring-based guard rejects any '..' run, even mid-name
    ];
    for (const member of malicious) {
      expect(tarMemberPathUnsafe(member), `expected ${JSON.stringify(member)} to be unsafe`).toBe(true);
    }
  });

  test("curated safe corpus is fully accepted", () => {
    const safe = [
      "main.tf",
      "terraform.tfvars",
      "./main.tf",
      "modules/net/vpc.tf",
      "a.b",
      "0/1",
      "-",
      ".",
    ];
    for (const member of safe) {
      expect(tarMemberPathUnsafe(member), `expected ${JSON.stringify(member)} to be safe`).toBe(false);
    }
  });

  test("fuzz: implementation never disagrees with its spec", () => {
    const spec = (m: string): boolean => m.startsWith("/") || m.includes("..");
    const rand = mulberry32(0x7a7a);
    for (let i = 0; i < 20_000; i++) {
      const member = randomPath(rand);
      expect(tarMemberPathUnsafe(member)).toBe(spec(member));
    }
  });
});

describe("tarMemberIsForbiddenSpecial (worker)", () => {
  test("all six forbidden type chars are rejected", () => {
    for (const c of ["l", "h", "c", "b", "p", "s"]) {
      expect(tarMemberIsForbiddenSpecial(c), `expected '${c}' to be forbidden`).toBe(true);
    }
  });

  test("regular files, directories, and unknown chars are allowed", () => {
    for (const c of ["f", "-", "0", "d", "z", "L", "S", "x", " ", ""]) {
      expect(tarMemberIsForbiddenSpecial(c), `expected '${JSON.stringify(c)}' to be allowed`).toBe(false);
    }
  });

  test("fuzz: rejection is exactly the six-char set", () => {
    const forbidden = new Set(["l", "h", "c", "b", "p", "s"]);
    const rand = mulberry32(0x51ec);
    const alphabet = "lhc bpsdf-0dzLxS!@#".split("");
    for (let i = 0; i < 10_000; i++) {
      const c = alphabet[Math.floor(rand() * alphabet.length)]!;
      expect(tarMemberIsForbiddenSpecial(c)).toBe(forbidden.has(c));
    }
  });
});
