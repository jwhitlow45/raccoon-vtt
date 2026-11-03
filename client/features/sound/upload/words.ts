import { MAX_NAME } from "#shared/protocol.ts";
import type { SoundUse } from "#shared/sound.ts";
import { ApiError } from "../../../lib/api.ts";
import { imageErrorMessage } from "../../images/errors.ts";

/**
 * Every word the Add buttons and their queues show
 * (docs/design/design-v1-sound.md 4.2), in one place so the tests pin them
 * and the panel's lane reads the same ones.
 */

/** The Add button of each section of the Sound panel. */
export const ADD_LABEL: Readonly<Record<SoundUse, string>> = {
  music: "Add music…",
  loop: "Add background sounds…",
  effect: "Add effects…",
};

/** The queue's list, named for its section, since the panel shows three. */
export const FILES_LABEL: Readonly<Record<SoundUse, string>> = {
  music: "Music being added",
  loop: "Background sounds being added",
  effect: "Effects being added",
};

export function filesLabel(use: SoundUse): string {
  return FILES_LABEL[use];
}

/** Where a file is, as its row says it. `percent` is a whole number from 0 to 100. */
export type RowStep =
  | { t: "waiting" }
  | { t: "reading" }
  | { t: "converting"; percent: number }
  | { t: "uploading"; percent: number }
  | { t: "adding" }
  | { t: "added" }
  | { t: "refused"; text: string };

export function stepWords(fileName: string, step: RowStep): string {
  switch (step.t) {
    case "waiting":
      return `${fileName}: waiting.`;
    case "reading":
      return `Reading ${fileName}…`;
    case "converting":
      return `Converting ${fileName}… ${step.percent}%`;
    case "uploading":
      return `Uploading ${fileName}… ${step.percent}%`;
    case "adding":
      return `Adding ${fileName}…`;
    case "added":
      return "";
    case "refused":
      return step.text;
  }
}

export function addedWords(name: string): string {
  return `Added ${name}.`;
}

/** Cancel's own name says which file it stops, since a queue holds several. */
export function cancelLabel(fileName: string): string {
  return `Cancel ${fileName}`;
}

export function dismissLabel(fileName: string): string {
  return `Dismiss ${fileName}`;
}

/** Why a file is refused before it goes up, each worded on its row (4.2). */
export type Refusal =
  | { t: "unreadable" }
  | { t: "tooLong" }
  | { t: "useTooLong"; use: SoundUse }
  | { t: "useTooShort"; use: SoundUse }
  | { t: "tooShort" }
  | { t: "tooBigToRead" }
  | { t: "outOfMemory" }
  | { t: "channels"; channels: number }
  | { t: "channelsUnknown" }
  | { t: "lengthUnknown" }
  | { t: "fileTooLarge" }
  | { t: "outOfStorage" }
  | { t: "failed" }
  | { t: "server"; text: string };

export const OUT_OF_STORAGE = "The room is out of storage space. Delete sounds or images it no longer uses.";

export function refusalWords(fileName: string, why: Refusal): string {
  switch (why.t) {
    case "unreadable":
      return `${fileName}: this browser can't read it. Try Chrome or Firefox, or make it an MP3 first.`;
    case "tooLong":
      return `${fileName}: longer than 15 minutes.`;
    case "useTooLong":
      // Only an effect has an upper cap under the file's own 15 minutes.
      return why.use === "effect" ? `${fileName}: an effect is 30 seconds at most. Add it as background or music.` : `${fileName}: longer than 15 minutes.`;
    case "useTooShort":
      return why.use === "music" ? `${fileName}: music is 30 seconds at least. Add it as an effect.` : `${fileName}: a background sound is 2 seconds at least.`;
    case "tooShort":
      return `${fileName}: shorter than a fifth of a second.`;
    case "tooBigToRead":
      return `${fileName} is too big for this device to read. Add it from a computer.`;
    case "outOfMemory":
      return `${fileName}: this device ran out of memory reading it. Add it from a computer.`;
    case "channels":
      return `${fileName} has ${why.channels} channels. Use a mono or stereo file.`;
    case "channelsUnknown":
      return `${fileName}: this app can't tell how many channels it has. Make it an MP3 or WAV first.`;
    case "lengthUnknown":
      return `${fileName}: this app can't tell how long it is. Make it an MP3 or WAV first.`;
    case "fileTooLarge":
      return `${fileName} is over 200 MB.`;
    case "outOfStorage":
      return OUT_OF_STORAGE;
    case "failed":
      return `${fileName}: converting it failed. Try again, or make it an MP3 first.`;
    case "server":
      return `${fileName}: ${why.text}`;
  }
}

/**
 * The upload route's refusals for a sound, which the panel's checks should
 * have caught first, so each is a plain sentence after the file's name.
 * The rest are the image upload's words (features/images/errors.ts), which
 * speak of no kind of file.
 */
export function uploadRefusal(err: unknown): Refusal {
  if (err instanceof ApiError) {
    if (err.code === "quota_exceeded") return { t: "outOfStorage" };
    if (err.code === "sound_type") return { t: "server", text: "the server couldn't read the converted file. Try again, or make it an MP3 first." };
    if (err.code === "sound_length") return { t: "server", text: "the server refused its length." };
    if (err.code === "sound_off") return { t: "server", text: "this server doesn't offer sound files." };
    if (err.code === "rate_limited") return { t: "server", text: "too many sounds in a short time. Wait a little and try again." };
    if (err.code === "too_large") return { t: "server", text: "too large for the server, which takes up to 24 MB." };
  }
  return { t: "server", text: imageErrorMessage(err) };
}

/**
 * A new sound's name from its file's (4.2): the name less its extension,
 * each `_` a space, without the control and direction characters names
 * may not hold, and at most MAX_NAME characters. A name left empty is
 * "Sound".
 */
export function soundNameOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const cleaned = stem
    .replace(/_/g, " ")
    .replace(/[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  // The schema counts UTF-16 units, and the cut falls between code points, so it never splits a surrogate pair.
  let name = "";
  for (const ch of cleaned) {
    if (name.length + ch.length > MAX_NAME) break;
    name += ch;
  }
  name = name.trim();
  return name === "" ? "Sound" : name;
}
