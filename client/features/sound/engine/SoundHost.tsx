import { useEffect, useLayoutEffect, useRef } from "react";
import type { Playing, Sound, SoundId } from "#shared/sound.ts";
import { setRoomSoundChoice } from "../../device/settings.ts";
import { chooseDisplaySound } from "../../display/remember.ts";
import { usePreview } from "../../dm/previewContext.ts";
import { soundTimeLink } from "../../../state/socket.ts";
import { useAssets, useIsDisplay, useRoomStore, useRoomView } from "../../../state/view.ts";
import { mixerSupported, soundUnlock } from "./context.ts";
import type { EngineInput, SoundEngine } from "./engine.ts";
import { setSoundHere, useRoomSoundOn } from "./store.ts";

/**
 * The room's sound on this page (docs/design/design-v1-music.md 5): in the
 * room above the blackout and scene gates (pages/Room.tsx), and in the table
 * display's room, so a DM's page plays on behind a blackout and nothing
 * stops for a scene change. It arms the unlock at once and loads the
 * engine (engine.ts) the first time the room plays something. View as a
 * player plays nothing, and neither does a room that ended.
 */
export function SoundHost() {
  const preview = usePreview();
  // A room that ended (signed out, refused, deleted) falls silent: its last state no longer plays.
  const ended = useRoomView((s) => s.ended !== null && s.ended !== undefined);
  if (preview || ended) return null;
  return <Host />;
}

const NO_SOUNDS: Readonly<Record<SoundId, Sound>> = Object.freeze({});

function Host() {
  const store = useRoomStore();
  const display = useIsDisplay();
  const assets = useAssets();
  const roomId = useRoomView((s) => s.roomId);
  // The confirmed state: devices play from it alone (6.3). Undefined while a reconnect has cleared it, null for nothing playing.
  const playing = useRoomView((s): Playing | null | undefined => (s.confirmed ? (s.confirmed.playing ?? null) : undefined));
  const sounds = useRoomView((s) => s.confirmed?.sounds ?? NO_SOUNDS);
  const connected = useRoomView((s) => s.connection === "open");
  const blackout = useRoomView((s) => s.view?.meta.view.blackout === true);
  const on = useRoomSoundOn();
  // A display behind a blackout is silent: its projection holds no sound then anyway.
  const enabled = on && !(display && blackout);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => soundUnlock().arm(() => enabledRef.current), []);

  const engine = useRef<SoundEngine | null>(null);
  const loading = useRef(false);
  const input: EngineInput = { playing, sounds, enabled, connected };
  const inputRef = useRef(input);
  inputRef.current = input;
  const roomName = useRef("");
  roomName.current = useRoomView((s) => s.view?.meta.name ?? "");
  const wanted = !!playing && (playing.music !== null || Object.keys(playing.loops).length > 0 || playing.effects.length > 0 || (playing.dmEffects?.length ?? 0) > 0);

  // The page's load as effects count it (5.4): its first confirmed state, which comes before the engine loads.
  const loadAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (loadAt.current !== null || playing === undefined) return;
    const offset = store.getState().serverOffset;
    loadAt.current = offset === undefined ? Date.now() : performance.now() + offset;
  }, [playing, store]);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      engine.current?.dispose();
      engine.current = null;
    };
  }, []);

  // The room, the display flag, the assets and the store are this page's for its whole life: Room and DisplayRoom remount for another room.
  useEffect(() => {
    if (engine.current || loading.current || !wanted || !mixerSupported()) return;
    loading.current = true;
    void import("./engine.ts").then(
      ({ SoundEngine }) => {
        loading.current = false;
        if (!alive.current || engine.current) return;
        engine.current = new SoundEngine({
          room: roomId,
          kind: display ? "display" : "member",
          roomName: () => roomName.current,
          url: (assetId) => assets.url(assetId, "full"),
          time: soundTimeLink(store),
          fallbackOffset: () => store.getState().serverOffset,
          setOn: (next) => (display ? chooseDisplaySound(next) : setRoomSoundChoice(next ? "on" : "off")),
          loadAt: () => loadAt.current,
        });
        engine.current.update(inputRef.current);
      },
      () => {
        // The chunk did not load: nothing plays, and the next change of what plays tries again.
        loading.current = false;
      },
    );
  }, [wanted, roomId, display, assets, store]);

  useLayoutEffect(() => {
    if (engine.current) {
      engine.current.update({ playing, sounds, enabled, connected });
      return;
    }
    // Before the engine loads, what the panel says follows the setting alone.
    setSoundHere({ here: !mixerSupported() ? "cannot" : enabled ? "plays" : "off", music: "none" });
  }, [playing, sounds, enabled, connected]);

  return null;
}
