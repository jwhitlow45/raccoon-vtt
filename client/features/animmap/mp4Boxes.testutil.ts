/**
 * MP4 and MOV boxes built byte by byte for the HEVC scan's tests
 * (hevcScan.ts), laid out as server/assets/video/videoTestutil.ts writes
 * them, so each test names exactly the file it scans. The scan reads only
 * box headers and the sample entry's type, so the tables are empty and the
 * media is zeros.
 */

export type Bytes = Uint8Array<ArrayBuffer>;

export function concat(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function word(value: number): Bytes {
  return Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

export function text(s: string): Bytes {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export const zeros = (n: number): Bytes => new Uint8Array(n);

/** A FullBox's version 0 and its flags. */
export const full = (flags = 0): Bytes => word(flags);

export function box(type: string, ...payload: readonly Uint8Array[]): Bytes {
  const body = concat(...payload);
  return concat(word(8 + body.length), text(type), body);
}

/** A box with a 64-bit size, as a camera writes an `mdat` that may pass 4 GiB. */
export function largeBox(type: string, ...payload: readonly Uint8Array[]): Bytes {
  const body = concat(...payload);
  return concat(word(1), text(type), word(0), word(16 + body.length), body);
}

/** A visual sample entry's 78 bytes before its child boxes. */
export const sampleEntry = (type: string): Bytes => box(type, zeros(6), Uint8Array.of(0, 1), zeros(70));

export const stsdOf = (...entries: readonly Uint8Array[]): Bytes => box("stsd", full(), word(entries.length), ...entries);

/** One track: its handler (`vide`, `soun`, `meta`) and its sample entry, or a whole `stsd` given. */
export function trak(handler: string, entry: string, o: { stsd?: Uint8Array } = {}): Bytes {
  const stbl = box("stbl", o.stsd ?? stsdOf(sampleEntry(entry)), box("stts", full(), word(0)), box("stsc", full(), word(0)), box("stsz", full(), word(0), word(0)), box("stco", full(), word(0)));
  const header = handler === "vide" ? box("vmhd", full(1), zeros(8)) : box("smhd", full(), zeros(4));
  const minf = box("minf", header, box("dinf", box("dref", full(), word(1), box("url ", full(1)))), stbl);
  const hdlr = box("hdlr", full(), word(0), text(handler), zeros(12), zeros(1));
  return box("trak", box("tkhd", full(3), zeros(80)), box("mdia", box("mdhd", full(), zeros(20)), hdlr, minf));
}

export type MovieOptions = {
  /** `qt  ` for a MOV, as an iPhone writes it, else an ISO MP4. */
  brand?: "qt  " | "isom";
  /** The video's sample entry, for the default one video track. */
  entry?: string;
  traks?: readonly Uint8Array[];
  /** `moov` after `mdat`, as a phone writes it, with a `wide` before `mdat`. */
  moovLast?: boolean;
  /** The media's length in bytes. */
  media?: number;
  /** `mdat` with a 64-bit size. */
  largeMdat?: boolean;
  /** Boxes inside `moov` after the tracks. */
  inMoov?: readonly Uint8Array[];
};

export const ftypOf = (brand: "qt  " | "isom" = "isom"): Bytes => box("ftyp", text(brand), word(0x200), text(brand));

export const moovOf = (...kids: readonly Uint8Array[]): Bytes => box("moov", box("mvhd", full(), zeros(96)), ...kids);

/** A file the server's MP4 check reads to its sample entry: `ftyp`, then `moov` and `mdat` in either order. */
export function movie(o: MovieOptions = {}): Bytes {
  const ftyp = ftypOf(o.brand);
  const moov = moovOf(...(o.traks ?? [trak("vide", o.entry ?? "avc1")]), ...(o.inMoov ?? []));
  const media = zeros(o.media ?? 4096);
  const mdat = o.largeMdat ? largeBox("mdat", media) : box("mdat", media);
  return o.moovLast ? concat(ftyp, box("wide"), mdat, moov) : concat(ftyp, moov, mdat);
}

/** A picked file of these bytes, as a MOV from an iPhone's picker or an MP4. */
export function picked(bytes: Uint8Array, as: "mov" | "mp4" = "mov"): File {
  return as === "mov" ? new File([bytes as Bytes], "IMG_0042.MOV", { type: "video/quicktime" }) : new File([bytes as Bytes], "harbor.mp4", { type: "video/mp4" });
}
