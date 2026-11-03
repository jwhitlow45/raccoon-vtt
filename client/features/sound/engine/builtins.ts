import type { TrapSound } from "#shared/model.ts";

/**
 * The built-in effects (docs/design/design-v1-music.md 5.4): the trap sounds
 * (docs/design/design-v1-traps.md 2 and 4.3), white noise through a filter
 * that sweeps, shaped to each and synthesized on every device, so nothing
 * downloads, no file needs a license, and they play while the server's
 * switch is off. features/encounter/alerts.ts plays the same shapes for a
 * trap, so the two never sound different.
 */

export type NoiseShape = { seconds: number; filter: BiquadFilterType; from: number; to: number; gain: number; attack: number };

export const TRAP_SOUND_SHAPES: Readonly<Record<TrapSound, NoiseShape>> = {
  click: { seconds: 0.06, filter: "highpass", from: 2500, to: 2500, gain: 0.5, attack: 0.002 },
  rumble: { seconds: 1.4, filter: "lowpass", from: 140, to: 50, gain: 0.9, attack: 0.1 },
  crash: { seconds: 0.9, filter: "bandpass", from: 900, to: 250, gain: 0.8, attack: 0.004 },
  whoosh: { seconds: 0.7, filter: "bandpass", from: 300, to: 2400, gain: 0.45, attack: 0.25 },
  hiss: { seconds: 1, filter: "highpass", from: 4000, to: 6500, gain: 0.25, attack: 0.06 },
};

/** How long a built-in sounds, in ms, for the effect list's "still sounding" and the board's pressed look. */
export function builtinMs(sound: TrapSound): number {
  return Math.ceil(TRAP_SOUND_SHAPES[sound].seconds * 1000);
}

const noise = new WeakMap<BaseAudioContext, AudioBuffer>();

/** A second and a half of white noise, made once per context. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const made = noise.get(ctx);
  if (made) return made;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 1.5), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noise.set(ctx, buffer);
  return buffer;
}

/**
 * Plays a shape at `at` on the context's clock into `destination`, from
 * `offset` seconds into it, so one started late keeps its own end. Returns
 * the source, which stops itself, so a caller can stop it sooner.
 */
export function playShape(ctx: BaseAudioContext, shape: NoiseShape, at: number, destination: AudioNode, offset = 0): AudioBufferSourceNode | null {
  const left = shape.seconds - offset;
  if (left <= 0) return null;
  const start = Math.max(at, ctx.currentTime);
  const end = start + left;
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = shape.filter;
  filter.frequency.setValueAtTime(shape.from, start);
  filter.frequency.exponentialRampToValueAtTime(shape.to, end);
  const gain = ctx.createGain();
  // A ramp in and an exponential fade, so it never clicks but for the click itself.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(shape.gain, start + Math.min(shape.attack, left / 2));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  source.connect(filter).connect(gain).connect(destination);
  source.start(start);
  source.stop(end + 0.02);
  return source;
}
