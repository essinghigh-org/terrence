import { deflateRawSync } from "node:zlib";

type FixtureEntry = Readonly<{ name: string; data?: string; mode?: number; method?: number; flags?: number; descriptor?: boolean }>;
function crc32(bytes: Readonly<Uint8Array>): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function azureDevOpsZipFixture(entries: readonly FixtureEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const method = entry.method ?? 8;
    const compressed = method === 0 ? data : deflateRawSync(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(entry.flags ?? (entry.descriptor === true ? 0x808 : 0x800), 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(entry.flags ?? (entry.descriptor === true ? 0x808 : 0x800), 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    const descriptor = Buffer.alloc(entry.descriptor === true ? 16 : 0);
    if (entry.descriptor === true) {
      local.fill(0, 14, 26);
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc32(data), 4);
      descriptor.writeUInt32LE(compressed.length, 8);
      descriptor.writeUInt32LE(data.length, 12);
    }
    locals.push(local, compressed, descriptor);
    centrals.push(central);
    offset += local.length + compressed.length + descriptor.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(
    centrals.reduce((sum, entry): number => sum + entry.length, 0),
    12,
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

