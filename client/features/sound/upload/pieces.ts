import type { Mp3Facts } from "#shared/audio/mp3.ts";

/**
 * A constant bitrate MP3 measured in 60-second pieces
 * (docs/design/design-v1-sound.md 4.2 step 2), so it is never held decoded
 * whole. Each piece is cut on frame boundaries, with the 10 frames before
 * it as pre-roll whose output is dropped, since a Layer III frame may draw
 * on the bits of frames before it (the bit reservoir). Counts are in the
 * file's own frames and converted to the decoder's 44.1 kHz output, so a
 * 48 kHz file's pre-roll is 10,584 output samples. This is for loudness
 * only: a few samples off at a seam do not move the result.
 */

export const PIECE_SECONDS = 60;
export const PRE_ROLL_FRAMES = 10;
export const OUTPUT_RATE = 44_100;
const SAMPLES_PER_FRAME = 1152;

export type Mp3Piece = {
  /** Bytes of the file to decode, pre-roll frames included. */
  start: number;
  end: number;
  /** Output samples to drop from the front, the pre-roll's. */
  drop: number;
  /** Output samples to keep after them: the piece's own frames. */
  keep: number;
};

/** Output samples at 44.1 kHz for this many of the file's own frames. */
export function outputSamples(frames: number, rateHz: number): number {
  return Math.round((frames * SAMPLES_PER_FRAME * OUTPUT_RATE) / rateHz);
}

export function mp3Pieces(facts: Pick<Mp3Facts, "rateHz" | "frames" | "offsets">, fileBytes: number): Mp3Piece[] {
  const perPiece = Math.max(1, Math.round((PIECE_SECONDS * facts.rateHz) / SAMPLES_PER_FRAME));
  const pieces: Mp3Piece[] = [];
  for (let first = 0; first < facts.frames; first += perPiece) {
    const last = Math.min(facts.frames, first + perPiece);
    const from = Math.max(0, first - PRE_ROLL_FRAMES);
    // Rounded at the piece's edges from the file's start, so the kept samples of all pieces add up to the whole.
    const keepFrom = outputSamples(first, facts.rateHz);
    pieces.push({
      start: facts.offsets[from]!,
      end: last < facts.frames ? facts.offsets[last]! : fileBytes,
      drop: keepFrom - outputSamples(from, facts.rateHz),
      keep: outputSamples(last, facts.rateHz) - keepFrom,
    });
  }
  return pieces;
}
