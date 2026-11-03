import { gzipSync, inflateRawSync } from "node:zlib";
import type { DeepReadonly } from "./types";
import { MAX_ARCHIVE_MEMBERS, MAX_EXPANDED_ARCHIVE_BYTES, tarMemberPathUnsafe } from "./archive";

export type AzureDevOpsArchiveLimits = Readonly<{
  maxCompressedBytes?: number;
  maxExpandedBytes?: number;
  maxFileBytes?: number;
  maxMembers?: number;
}>;

type ZipEntry = Readonly<{
  name: string;
  directory: boolean;
  executable: boolean;
  flags: number;
  method: number;
  crc: number;
  compressed: number;
  expanded: number;
  offset: number;
}>;

function invalid(reason: string): never {
  throw new Error(`Invalid Azure DevOps ZIP archive: ${reason}`);
}

function u16(bytes: DeepReadonly<Uint8Array>, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) invalid("truncated field");
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u32(bytes: DeepReadonly<Uint8Array>, offset: number): number {
  return (u16(bytes, offset) | (u16(bytes, offset + 2) << 16)) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index): number => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
  return value >>> 0;
});

function crc32(bytes: DeepReadonly<Uint8Array>): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  return (crc ^ 0xffffffff) >>> 0;
}

function archiveEnd(bytes: DeepReadonly<Uint8Array>): number {
  const lower = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= lower; offset--) {
    if (u32(bytes, offset) === 0x06054b50 && offset + 22 + u16(bytes, offset + 20) === bytes.length) return offset;
  }
  return invalid("missing end record");
}

function entryName(bytes: DeepReadonly<Uint8Array>, offset: number, length: number): string {
  if (offset + length > bytes.length) invalid("truncated filename");
  const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(offset, offset + length));
  if (
    name === "" ||
    tarMemberPathUnsafe(name) ||
    name.includes("\\") ||
    /^[A-Za-z]:/.test(name) ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    name.split("/").some((part, index, parts): boolean => part === "." || (part === "" && index !== parts.length - 1))
  )
    invalid("unsafe path");
  return name;
}

function entryType(
  bytes: DeepReadonly<Uint8Array>,
  offset: number,
  name: string,
): Readonly<{ directory: boolean; executable: boolean }> {
  const mode = u32(bytes, offset + 38) >>> 16;
  const type = mode & 0xf000;
  const directory = name.endsWith("/");
  if (type !== 0 && type !== 0x8000 && type !== 0x4000) invalid("link or special file");
  if ((type === 0x4000 && !directory) || (type === 0x8000 && directory)) invalid("inconsistent file type");
  return { directory, executable: !directory && (mode & 0o111) !== 0 };
}

function validateExtraFields(bytes: DeepReadonly<Uint8Array>, start: number, length: number): void {
  const end = start + length;
  if (end > bytes.length) invalid("truncated extra fields");
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) invalid("truncated extra field");
    if (u16(bytes, offset) === 1) invalid("ZIP64 is unsupported");
    offset += 4 + u16(bytes, offset + 2);
  }
  if (offset !== end) invalid("invalid extra field length");
}

function readEntry(bytes: DeepReadonly<Uint8Array>, offset: number): ZipEntry {
  if (u32(bytes, offset) !== 0x02014b50) invalid("invalid central directory entry");
  const flags = u16(bytes, offset + 8);
  const method = u16(bytes, offset + 10);
  if ((flags & ~0x080e) !== 0 || (method !== 0 && method !== 8)) invalid("unsupported encryption or compression");
  if (u16(bytes, offset + 34) !== 0) invalid("multi-disk entry");
  const name = entryName(bytes, offset + 46, u16(bytes, offset + 28));
  validateExtraFields(bytes, offset + 46 + u16(bytes, offset + 28), u16(bytes, offset + 30));
  return {
    name,
    ...entryType(bytes, offset, name),
    flags,
    method,
    crc: u32(bytes, offset + 16),
    compressed: u32(bytes, offset + 20),
    expanded: u32(bytes, offset + 24),
    offset: u32(bytes, offset + 42),
  };
}

function boundedLimit(value: number | undefined, maximum: number): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) invalid("invalid size limit");
  return limit;
}

function entries(
  bytes: DeepReadonly<Uint8Array>,
  limits: AzureDevOpsArchiveLimits,
): Readonly<{ entries: readonly ZipEntry[]; central: number }> {
  const end = archiveEnd(bytes);
  const count = u16(bytes, end + 10);
  const central = u32(bytes, end + 16);
  if (u16(bytes, end + 4) !== 0 || u16(bytes, end + 6) !== 0 || u16(bytes, end + 8) !== count)
    invalid("multi-disk archive");
  if (count < 1 || count > Math.min(65534, boundedLimit(limits.maxMembers, MAX_ARCHIVE_MEMBERS)))
    invalid("invalid member count");
  if (central + u32(bytes, end + 12) !== end) invalid("invalid central directory bounds or ZIP64");
  const maxFile = boundedLimit(limits.maxFileBytes, MAX_EXPANDED_ARCHIVE_BYTES);
  const maxExpanded = boundedLimit(limits.maxExpandedBytes, MAX_EXPANDED_ARCHIVE_BYTES);
  const result: ZipEntry[] = [];
  const paths = new Set<string>();
  let offset = central;
  let expanded = 1024;
  for (let index = 0; index < count; index++) {
    const entry = readEntry(bytes, offset);
    const canonical = entry.name.replace(/\/$/u, "");
    if (paths.has(canonical)) invalid("duplicate path");
    paths.add(canonical);
    expanded += 512 + Math.ceil(entry.expanded / 512) * 512;
    if (entry.expanded > maxFile || expanded > maxExpanded) invalid("expanded byte limit exceeded");
    if (entry.directory && entry.expanded !== 0) invalid("nonempty directory");
    result.push(entry);
    offset += 46 + u16(bytes, offset + 28) + u16(bytes, offset + 30) + u16(bytes, offset + 32);
    if (offset > end) invalid("central directory overflow");
  }
  if (offset !== end) invalid("unexpected central directory data");
  return { entries: result, central };
}

function validateLocalMetadata(bytes: DeepReadonly<Uint8Array>, entry: ZipEntry): void {
  if ((entry.flags & 8) !== 0) return;
  const offset = entry.offset;
  if (
    u32(bytes, offset + 14) !== entry.crc ||
    u32(bytes, offset + 18) !== entry.compressed ||
    u32(bytes, offset + 22) !== entry.expanded
  )
    invalid("local size or CRC mismatch");
}

function descriptorEnd(bytes: DeepReadonly<Uint8Array>, entry: ZipEntry, end: number, central: number): number {
  if ((entry.flags & 8) === 0) return end;
  const start = u32(bytes, end) === 0x08074b50 ? end + 4 : end;
  if (
    start + 12 > central ||
    u32(bytes, start) !== entry.crc ||
    u32(bytes, start + 4) !== entry.compressed ||
    u32(bytes, start + 8) !== entry.expanded
  )
    invalid("invalid data descriptor");
  return start + 12;
}

function validateHierarchy(items: readonly ZipEntry[]): void {
  const files = new Set(items.filter((entry): boolean => !entry.directory).map((entry): string => entry.name));
  for (const entry of items) {
    const parts = entry.name.split("/");
    for (let length = 1; length < parts.length; length++) {
      if (files.has(parts.slice(0, length).join("/"))) invalid("file is also a parent directory");
    }
  }
}

function inflateEntry(
  bytes: DeepReadonly<Uint8Array>,
  entry: ZipEntry,
  central: number,
): Readonly<{ data: Uint8Array; end: number }> {
  const offset = entry.offset;
  if (
    u32(bytes, offset) !== 0x04034b50 ||
    u16(bytes, offset + 6) !== entry.flags ||
    u16(bytes, offset + 8) !== entry.method
  )
    invalid("local header mismatch");
  if (entryName(bytes, offset + 30, u16(bytes, offset + 26)) !== entry.name) invalid("local path mismatch");
  validateLocalMetadata(bytes, entry);
  const extraStart = offset + 30 + u16(bytes, offset + 26);
  validateExtraFields(bytes, extraStart, u16(bytes, offset + 28));
  const start = extraStart + u16(bytes, offset + 28);
  const end = start + entry.compressed;
  if (end > central || start > end) invalid("entry overlaps central directory");
  const input = bytes.slice(start, end);
  const data = entry.method === 0 ? input : inflateRawSync(input, { maxOutputLength: Math.max(1, entry.expanded) });
  if (data.length !== entry.expanded || crc32(data) !== entry.crc) invalid("size or CRC mismatch");
  return { data, end: descriptorEnd(bytes, entry, end, central) };
}

// eslint-disable-next-line @typescript-eslint/prefer-readonly-parameter-types -- This helper fills the newly allocated mutable tar header.
function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  header.set(new TextEncoder().encode(value.toString(8).padStart(length - 1, "0") + "\0"), offset);
}

function tarHeader(entry: Readonly<Pick<ZipEntry, "name" | "directory" | "executable" | "expanded">>): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();
  let name = entry.name;
  if (encoder.encode(name).length > 100) {
    const split = name.lastIndexOf("/", name.length - 2);
    const prefix = name.slice(0, split);
    name = name.slice(split + 1);
    if (split < 0 || encoder.encode(prefix).length > 155 || encoder.encode(name).length > 100)
      invalid("path exceeds portable tar limits");
    header.set(encoder.encode(prefix), 345);
  }
  header.set(encoder.encode(name));
  writeOctal(header, 100, 8, entry.directory ? 0o755 : entry.executable ? 0o755 : 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.expanded);
  writeOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header[156] = entry.directory ? 53 : 48;
  header.set(encoder.encode("ustar\0"), 257);
  header.set(encoder.encode("00"), 263);
  const checksum = header.reduce((sum, byte): number => sum + byte, 0);
  header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);
  return header;
}

/** Convert a bounded ZIP entirely in memory; never extract attacker-controlled paths to disk. */
export function azureDevOpsZipToTarGz(
  archive: DeepReadonly<Uint8Array>,
  limits: AzureDevOpsArchiveLimits = {},
): Uint8Array {
  if (archive.length > boundedLimit(limits.maxCompressedBytes, 100 * 1024 * 1024))
    invalid("compressed byte limit exceeded");
  const directory = entries(archive, limits);
  validateHierarchy(directory.entries);
  const ordered = [...directory.entries].sort((a, b): number => a.offset - b.offset);
  const chunks: Uint8Array[] = [];
  let previousEnd = 0;
  for (const entry of ordered) {
    if (entry.offset < previousEnd) invalid("overlapping entries");
    if (entry.offset !== previousEnd) invalid("unexpected data between entries");
    const { data, end } = inflateEntry(archive, entry, directory.central);
    previousEnd = end;
    chunks.push(tarHeader(entry), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding !== 0) chunks.push(new Uint8Array(padding));
  }
  if (previousEnd !== directory.central) invalid("unexpected data before central directory");
  chunks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(chunks));
}

/** Pack validated REST Git blobs without invoking Git or extracting paths to disk. */
export function azureDevOpsFilesToTarGz(
  files: DeepReadonly<{ name: string; data: Uint8Array; executable: boolean }[]>,
  limits: AzureDevOpsArchiveLimits = {},
): Uint8Array {
  if (files.length > boundedLimit(limits.maxMembers, MAX_ARCHIVE_MEMBERS)) invalid("member count exceeded");
  const names = new Set<string>();
  const chunks: Uint8Array[] = [];
  let expanded = 1024;
  for (const file of files) {
    const encoded = new TextEncoder().encode(file.name);
    entryName(encoded, 0, encoded.length);
    if (file.name.endsWith("/") || names.has(file.name)) invalid("duplicate or directory path");
    names.add(file.name);
    expanded += 512 + Math.ceil(file.data.length / 512) * 512;
    if (
      expanded > boundedLimit(limits.maxExpandedBytes, MAX_EXPANDED_ARCHIVE_BYTES) ||
      file.data.length > boundedLimit(limits.maxFileBytes, MAX_EXPANDED_ARCHIVE_BYTES)
    )
      invalid("expanded byte limit exceeded");
    chunks.push(
      tarHeader({ name: file.name, directory: false, executable: file.executable, expanded: file.data.length }),
      Uint8Array.from(file.data),
    );
    const padding = (512 - (file.data.length % 512)) % 512;
    if (padding !== 0) chunks.push(new Uint8Array(padding));
  }
  for (const name of names) {
    const parts = name.split("/");
    for (let length = 1; length < parts.length; length++) {
      if (names.has(parts.slice(0, length).join("/"))) invalid("file is also a parent directory");
    }
  }
  chunks.push(new Uint8Array(1024));
  const archive = gzipSync(Buffer.concat(chunks));
  if (archive.length > boundedLimit(limits.maxCompressedBytes, 100 * 1024 * 1024))
    invalid("compressed byte limit exceeded");
  return archive;
}
