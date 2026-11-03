import { stripTags, walkMp3, type Mp3Facts } from "#shared/audio/mp3.ts";

/**
 * An MP3 the room may keep as it is (docs/design/design-v1-sound.md 4.2
 * step 5, 7.1): its tags stripped, then the server's own strict walk, so a
 * file copied here is one the server takes. Its frames are copied, never
 * decoded and encoded again, and the copy holds no tag, so no title,
 * artist or cover art reaches the room.
 *
 * A leading Xing, Info or LAME frame goes too: it carries a seek table
 * and the encoder's own counts, nothing a player of a constant bitrate
 * file needs, and every field of it would be one more thing the server
 * keeps on the file's word. A file the walk refuses, a CRC or emphasis
 * frame included, is encoded instead (D-261102-690).
 */

/** `bytes` are the audio frames alone, and `facts.offsets` count from their first byte. */
export type CopyCheck = { ok: true; bytes: Uint8Array; facts: Mp3Facts; stripped: number } | { ok: false; why: string };

export function copyable(file: Uint8Array): CopyCheck {
  const untagged = stripTags(file);
  if (!untagged.ok) return { ok: false, why: untagged.why };
  const walk = walkMp3(untagged.bytes);
  if (!walk.ok) return { ok: false, why: walk.why };
  const first = walk.facts.offsets[0] ?? 0;
  const facts = first === 0 ? walk.facts : { ...walk.facts, offsets: walk.facts.offsets.map((at) => at - first) };
  return { ok: true, bytes: untagged.bytes.subarray(first), facts, stripped: untagged.stripped + first };
}

/** The room's copy: the frames alone, in a Blob of their own, so the file's buffer can go. */
export function copiedFile(frames: Uint8Array): Blob {
  return new Blob([frames.slice() as Uint8Array<ArrayBuffer>], { type: "audio/mpeg" });
}
