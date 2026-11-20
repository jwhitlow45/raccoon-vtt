/**
 * A zip file of stored entries, the one format every phone, computer and
 * VTT opens, written here so Export every floor needs no library
 * (docs/design/design-v1-floors.md phase 4, 9.3, D-261119-055). PNGs are
 * compressed already, so the entries are stored as they are: no deflate,
 * only the headers, a CRC-32 of each entry and the central directory.
 *
 * Each entry's bytes are read once, for its CRC, and the file is a Blob of
 * the headers around the entries' own Blobs, so the pictures are never
 * copied into one buffer.
 */

export type ZipEntry = { name: string; data: Blob };

/** The zip format's 32-bit sizes and offsets: the export stays far below them, and a file past them would need ZIP64. */
const MAX_BYTES = 0xffff_ffff;

/** The CRC-32 the zip format uses (the IEEE polynomial, reflected), one table for every call. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The MS-DOS time and date each header carries, in local time as zip tools read it. Years before 1980 cannot be written, so they read as 1980. */
function dosTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * The zip of `entries`, in their order, each stored. Names are written as
 * UTF-8 with the format's flag for it, so a name past ASCII reads the same
 * in every tool. Two entries of one name are refused: an unzip would write
 * one over the other.
 */
export async function storedZip(entries: readonly ZipEntry[], when: Date = new Date()): Promise<Blob> {
  if (entries.length > 0xffff) throw new RangeError("too many zip entries");
  const names = new Set<string>();
  const { time, date } = dosTime(when);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: ArrayBuffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    if (names.has(entry.name)) throw new RangeError(`two zip entries are named ${entry.name}`);
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    const size = entry.data.size;
    if (size > MAX_BYTES || offset > MAX_BYTES) throw new RangeError("the zip would pass 4 GB");
    const crc = crc32(new Uint8Array(await entry.data.arrayBuffer()));
    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    writeCommon(local, 4, { time, date, crc, size, nameLength: name.length });
    new Uint8Array(local.buffer).set(name, 30);
    const head = new DataView(new ArrayBuffer(46 + name.length));
    head.setUint32(0, 0x02014b50, true);
    // Made by version 2.0 on MS-DOS, the plainest host: no file modes to read.
    head.setUint16(4, 20, true);
    writeCommon(head, 6, { time, date, crc, size, nameLength: name.length });
    // Comment length, disk number, internal and external attributes stay 0.
    head.setUint32(42, offset, true);
    new Uint8Array(head.buffer).set(name, 46);
    parts.push(local.buffer, entry.data);
    central.push(head.buffer);
    offset += local.byteLength + size;
  }
  const centralSize = central.reduce((n, c) => n + c.byteLength, 0);
  if (offset > MAX_BYTES || offset + centralSize > MAX_BYTES) throw new RangeError("the zip would pass 4 GB");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

/** The fields a local header and a central directory header share, from version needed to the extra field's length, at `at`. */
function writeCommon(view: DataView, at: number, f: { time: number; date: number; crc: number; size: number; nameLength: number }): void {
  // Version 2.0 is needed to extract, the UTF-8 name flag is set, and the method is 0, stored.
  view.setUint16(at, 20, true);
  view.setUint16(at + 2, 0x0800, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, f.time, true);
  view.setUint16(at + 8, f.date, true);
  view.setUint32(at + 10, f.crc, true);
  view.setUint32(at + 14, f.size, true);
  view.setUint32(at + 18, f.size, true);
  view.setUint16(at + 22, f.nameLength, true);
  view.setUint16(at + 24, 0, true);
}
