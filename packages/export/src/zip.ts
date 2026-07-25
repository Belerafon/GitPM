import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  readonly name: string;
  readonly content?: Buffer;
  readonly date?: Date;
  readonly mode?: number;
  readonly directory?: boolean;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(content: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of content) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value: Date): { readonly date: number; readonly time: number } {
  const year = Math.max(1980, value.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
  };
}

function localHeader(name: Buffer, crc: number, compressedSize: number, size: number, date: number, time: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  return header;
}

function centralHeader(name: Buffer, crc: number, compressedSize: number, size: number, date: number, time: number, offset: number, mode: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x031e, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE((mode << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function normalizedName(value: string, directory: boolean): string {
  const name = value.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (name === "" || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Invalid ZIP entry name: ${value}`);
  }
  return directory && !name.endsWith("/") ? `${name}/` : name;
}

export function createZip(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const directory = entry.directory ?? false;
    const name = Buffer.from(normalizedName(entry.name, directory), "utf8");
    const content = directory ? Buffer.alloc(0) : entry.content ?? Buffer.alloc(0);
    const compressed = deflateRawSync(content);
    const checksum = crc32(content);
    const stamp = dosDateTime(entry.date ?? new Date(0));
    const mode = entry.mode ?? (directory ? 0o40755 : 0o100644);
    const local = localHeader(name, checksum, compressed.length, content.length, stamp.date, stamp.time);
    const central = centralHeader(name, checksum, compressed.length, content.length, stamp.date, stamp.time, offset, mode);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}
