import { stripTags, walkMp3, type Mp3Facts } from "#shared/audio/mp3.ts";

/**
 * An MP3 the room may keep as it is (docs/design/design-v1-sound.md 4.2
 * step 5, 7.1): its tags stripped, then the server's own strict walk, so a
 * file copied here is one the server takes. Its frames are copied, never
 * decoded and encoded again, and the copy holds no tag, so no title,
 * artist or cover art reaches the room.
 */

export type CopyCheck = { ok: true; bytes: Uint8Array; facts: Mp3Facts; stripped: number } | { ok: false; why: string };

export function copyable(file: Uint8Array): CopyCheck {
  const untagged = stripTags(file);
  if (!untagged.ok) return { ok: false, why: untagged.why };
  const walk = walkMp3(untagged.bytes);
  if (!walk.ok) return { ok: false, why: walk.why };
  return { ok: true, bytes: untagged.bytes, facts: walk.facts, stripped: untagged.stripped };
}

/** The room's copy: the frames alone, in a Blob of their own, so the file's buffer can go. */
export function copiedFile(frames: Uint8Array): Blob {
  return new Blob([frames.slice() as Uint8Array<ArrayBuffer>], { type: "audio/mpeg" });
}
