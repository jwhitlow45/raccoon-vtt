/**
 * The MP3 check both sides run (docs/design/design-v1-sound.md 7.1). It reads
 * frame headers only and decodes nothing, so a crafted file meets no
 * decoder on the server (D-261102-463). The server stores a file only when
 * `walkMp3` takes it whole. The DM's browser runs `stripTags` and then the
 * same walk, to tell a file it may copy from one it must encode.
 */

/** What a file the walk takes is. */
export type Mp3Facts = {
  rateHz: 44_100 | 48_000;
  /** The one bitrate of every frame, 64 to 192. */
  kbps: number;
  /** Mono, or any two-channel mode (stereo, joint stereo, dual channel), one mode for every frame. */
  channels: 1 | 2;
  /** Every frame but a leading Xing, Info or LAME frame. */
  frames: number;
  /** `frames` times 1152 over the rate, rounded down, from 0.2 s to SOUND_LIMITS.fileMaxMs. */
  ms: number;
  /** Each counted frame's first byte, in order, so the DM's browser cuts pieces on frame boundaries (4.2). */
  offsets: Uint32Array;
};

/**
 * Why the walk refused: `sound_type` for anything but the one accepted
 * form (another layer, version, rate or bitrate, a second bitrate or mode,
 * a tag, a stray byte, a cut last frame), `sound_length` for a well-formed
 * file of the wrong length. `why` is for logs and tests, never shown.
 */
export type Mp3Refusal = { ok: false; code: "sound_type" | "sound_length"; why: string };

export type Mp3Walk = { ok: true; facts: Mp3Facts } | Mp3Refusal;

/**
 * Takes a file that is MPEG-1 Layer III from its first byte to its last,
 * at 44.1 or 48 kHz, every frame at one bitrate from 64 to 192 kbps and one
 * channel mode, with at most one Xing, Info or LAME frame first, ending on a
 * frame boundary, with no tag and no other byte.
 */
export function walkMp3(bytes: Uint8Array): Mp3Walk {
  throw new Error("not built");
}

/**
 * The file without its tags, for the DM's browser before it walks a file
 * to copy: an ID3v2 tag at the start by its own size (at most
 * SOUND_LIMITS.id3v2MaxBytes), and ID3v1, APEv2 and Lyrics3 tags at the
 * end, at most SOUND_LIMITS.endTagsMax. `bytes` is a view of the input, not
 * a copy. A tag whose size runs past the file or its bound is `sound_type`.
 */
export function stripTags(bytes: Uint8Array): { ok: true; bytes: Uint8Array; stripped: number } | { ok: false; code: "sound_type"; why: string } {
  throw new Error("not built");
}
