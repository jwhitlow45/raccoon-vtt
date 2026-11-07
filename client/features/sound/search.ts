import { SOUND_PANEL } from "../panels.ts";
import { action, page, section, setting, type Place } from "../search/catalog/write.ts";
import type { CatalogEntry, SearchContext } from "../search/catalog/types.ts";
import { serverSound } from "./engine/store.ts";

/*
 * Sound in the room search (designs/qol/search.md 4 and 5.10): its two
 * views, Now playing and Library, and what each holds. A DM's alone, so
 * these load with the DM's catalog only (catalog/dm.ts): nothing but that
 * file imports this one. A player's Sound panel is their device's sound,
 * which This device's rows find. Each anchor is the `search=` id on its
 * control in SoundPanel.tsx and the parts it draws. Now playing's route is
 * the Now playing chip's Open Sound (search/route.ts NOW_PLAYING), and the
 * playlists and tracks are the index's rows (search/index.ts).
 */

const NOW: Place = { panel: SOUND_PANEL, page: "now", where: "Sound", icon: "music" };
const LIBRARY: Place = { panel: SOUND_PANEL, page: "library", where: "Sound", icon: "music" };
const IN_LIBRARY: Place = { ...LIBRARY, where: "Sound · Library" };

/** Sound files are on, which Library, Table sound and Background wait for (SoundPanel.tsx DmSoundFirstPage). Until the server says, they are not offered. */
const filesOn = () => serverSound() === "on";
/** Music plays, so Up next has a queue to show (SoundPanel.tsx UpNextFold). */
const musicOn = (ctx: SearchContext) => filesOn() && (ctx.state.view?.playing?.music ?? null) !== null;
/** Anything sounds, so Stop all sound shows under the player (NowFull.tsx). */
const sounding = (ctx: SearchContext) => {
  const playing = ctx.state.view?.playing;
  return filesOn() && !!playing && (playing.music !== null || Object.keys(playing.loops).length > 0);
};

export const SOUND_ENTRIES: readonly CatalogEntry[] = [
  page(NOW, "sound.now", "Now playing", { names: ["music player"], bets: ["music"] }),
  page(LIBRARY, "sound.library", "Library", { names: ["music library", "playlists", "tracks"], when: filesOn }),
  action(NOW, "sound.stop-all", "Stop all sound", { names: ["silence"], when: sounding }),
  section({ ...NOW, section: "upnext" }, "sound.upnext", "Up next", { names: ["queue"], when: musicOn }),
  section(NOW, "sound.effects", "Effects", { names: ["sound effects", "effects board"] }),
  section(NOW, "sound.table", "Table sound", { names: ["volume for everyone", "mix"], when: filesOn }),
  setting(NOW, "sound.table.names", "Players see what is playing", { names: ["track names"], when: filesOn, valueNow: (ctx) => (ctx.state.view?.meta.settings.soundNames ? "On" : "Off") }),
  section(NOW, "sound.background", "Background", { names: ["background sounds", "ambience", "loops"], when: filesOn }),
  action(IN_LIBRARY, "sound.library.new-playlist", "New playlist", { names: ["make a playlist"], when: filesOn }),
  action(IN_LIBRARY, "sound.library.add", "Add music…", { names: ["upload music", "add songs"], when: filesOn }),
];
