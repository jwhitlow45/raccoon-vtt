import { useEffect, useSyncExternalStore } from "react";
import type { MapVideo } from "#shared/model.ts";
import { useAnimatedMaps, useLowPower, useMapVariant } from "../device/settings.ts";
import { useReducedMotion } from "../weather/store.ts";
import { pageSteppedDown, subscribePageStepDown } from "./board.ts";
import { decodable, decodableKey, settledDecodable, subscribeDecodable } from "./capabilities.ts";
import { playback, type Decodable, type PlaybackInput } from "./playback.ts";
import { useBoardVideo, useServerAnimatedMapsKnown, type BoardVideo, type Playback } from "./status.ts";

/**
 * What this device does with one video (docs/design/design-v1-animated-maps.md
 * 4.2 and 4.6): the board's own status while the board handles that video,
 * since only the board knows a refused `play()` or a setup tool showing,
 * else the device's playback rule (playback.ts), the one the board applies.
 * Every input to the rule is read live, so turning on Low power or reduced
 * motion, a step-down, or the server's answer judges again at once
 * (AMBUILD-ASTRA-05, AM-R1-03). Only the browser's answer for the file is
 * kept, per file and question (capabilities.ts). It needs no board, so a
 * Library viewer in a room with no scene showing answers too.
 */

/** The rule's inputs this device knows of itself, the server's switch null until the server answers. */
export type DeviceInput = Pick<PlaybackInput, "setting" | "lowPower" | "reducedMotion" | "variant" | "steppedDown"> & { server: boolean | null };

export function useVideoPlayback(video: MapVideo | null | undefined): Playback | null {
  const board = useBoardVideo();
  const device: DeviceInput = {
    server: useServerAnimatedMapsKnown(),
    setting: useAnimatedMaps(),
    lowPower: useLowPower(),
    reducedMotion: useReducedMotion(),
    variant: useMapVariant(),
    steppedDown: useSyncExternalStore(subscribePageStepDown, pageSteppedDown, pageSteppedDown),
  };
  const answer = useDecodable(video ?? null, device.variant === "mobile");
  return videoPlayback(video, board, device, answer);
}

/** The browser's answer for one file, asked once and read from the page's answers as it comes. Null until then. */
function useDecodable(video: MapVideo | null, powerEfficient: boolean): Decodable | null {
  const read = () => (video ? (settledDecodable(video, powerEfficient) ?? null) : null);
  const answer = useSyncExternalStore(subscribeDecodable, read, read);
  const key = video ? decodableKey(video, powerEfficient) : null;
  useEffect(() => {
    if (video) void decodable(video, powerEfficient);
    // The key names the file's facts and the question, which is all the answer depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer;
}

/**
 * The playback the hook gives, from what it read. The device's own choices
 * come before the browser's answer in the rule, so a still they make needs
 * no answer: only a video they would let move waits for it.
 */
export function videoPlayback(video: MapVideo | null | undefined, board: BoardVideo, device: DeviceInput, answer: Decodable | null): Playback | null {
  if (!video) return null;
  const onBoard = boardPlayback(board, video);
  if (onBoard) return onBoard;
  if (device.server === null) return null;
  const input = { ...device, server: device.server };
  const before = playback(video, { ...input, decodable: "codec" });
  if (before.reason !== "codec") return before;
  return answer === null ? null : playback(video, { ...input, decodable: answer });
}

/** The board's playback when the board handles this very video, else null. */
export function boardPlayback(board: BoardVideo, video: Pick<MapVideo, "assetId"> | null | undefined): Playback | null {
  return board && video && board.assetId === video.assetId ? board.playback : null;
}
