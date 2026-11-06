import type { MusicShown } from "../sound/panel/state.ts";
import { runLine } from "../sound/panel/words.ts";

/*
 * Ambiance's own words (docs/design/design-v1-panel-groups.md 4.2 and 9):
 * what its folded groups say they hold, the Weather row's name, and a
 * player's line when there is nothing to show. Plain functions, for node
 * --test, so the render tests, the e2e steps and the guide read one text.
 */

export const AMBIANCE_TITLE = "Ambiance";
export const TIME_GROUP = "Time";
export const WEATHER_ROW = "Weather";
export const SOUND_GROUP = "Sound";
export const WHAT_PLAYERS_HEAR = "What players hear";
export const SCENE_SOUND = "Scene sound";
export const SCENE_SOUND_OPEN = "Scene sound, in Scenes";
export const NO_SCENE = "No scene";
export const NOT_STARTED = "Not started";
export const EMPTY_LINE = "The DM isn't sharing the date and time or playing sound now.";

/** The DM guide's sections each group links, the anchors the Time and Sound panels had (7). */
export const AMBIANCE_GUIDES = { time: "time-and-the-calendar", sound: "music-and-sound" } as const;

const join = (parts: readonly (string | null)[]): string => parts.filter((p) => p !== null).join(" · ");

/** "1 background sound", "3 background sounds": Sound's summary and Now playing's line with no music. */
export function backgroundCount(n: number): string {
  return n === 1 ? "1 background sound" : `${n} background sounds`;
}

/** Time folded: the top bar chip's own text, then "Hidden" while players don't see it, else "Not started" with no clock. */
export function timeSummary(clock: { chip: string; shown: boolean } | null): string {
  if (clock === null) return NOT_STARTED;
  return join([clock.chip, clock.shown ? null : "Hidden"]);
}

/**
 * Sound folded: the music, by its playlist's run line or its one track's
 * name, "Paused" while paused, then how many background sounds play.
 * Effects never count: they end in seconds.
 */
export function soundSummary(music: Pick<MusicShown, "name" | "paused" | "playlistName" | "place" | "count" | "single"> | null, loops: number): string {
  const parts: (string | null)[] = [];
  if (music) {
    parts.push(music.single ? music.name : runLine(music));
    if (music.paused) parts.push("Paused");
  }
  if (loops > 0) parts.push(backgroundCount(loops));
  return parts.length === 0 ? "Nothing is playing" : join(parts);
}

/** The Weather row's button name: what the row says, and where it opens (scenes-reorg 4.2). */
export function weatherRowLabel(scene: { name: string; summary: string } | null): string {
  return scene === null ? "Weather: no scene, in Scenes" : `Weather: ${scene.summary}, in ${scene.name}'s settings`;
}
