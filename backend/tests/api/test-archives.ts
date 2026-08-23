import { gzipSync } from "node:zlib";

/** Return a small valid gzip-compressed tar archive for upload contract tests. */
export function validTarGzip(content = ""): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(content, "utf8");
  const header = Buffer.alloc(512);
  header.write("main.tf", 0, "utf8");
  header.write("0000644\0", 100, "ascii");
  header.write("0000000\0", 108, "ascii");
  header.write("0000000\0", 116, "ascii");
  header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
  header.write("00000000000\0", 136, "ascii");
  header[156] = 0x30;
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  const paddedLength = Math.ceil(bytes.length / 512) * 512;
  const body = Buffer.concat([header, Buffer.concat([bytes, Buffer.alloc(paddedLength - bytes.length)]), Buffer.alloc(1024)]);
  const compressed = gzipSync(body);
  const output = new Uint8Array(new ArrayBuffer(compressed.byteLength));
  output.set(compressed);
  return output;
}
