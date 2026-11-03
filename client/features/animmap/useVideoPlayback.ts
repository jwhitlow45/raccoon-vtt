import { useEffect, useState } from "react";
import type { MapVideo } from "#shared/model.ts";
import { judgeVideo, useBoardVideo, type BoardVideo, type Playback } from "./status.ts";

/**
 * What this device does with one video (docs/design/design-v1-animated-maps.md
 * 4.2 and 4.6): the board's own status while the board handles that video,
 * since only the board knows a refused `play()`, a step-down or a setup tool
 * showing, else the device's judgment from the board's lane (status.ts
 * `judgeVideo`), asked once per video. Null until known.
 */
export function useVideoPlayback(video: MapVideo | null | undefined): Playback | null {
  const board = useBoardVideo();
  const onBoard = boardPlayback(board, video);
  const [judged, setJudged] = useState<{ assetId: string; playback: Playback } | null>(null);
  const assetId = video?.assetId;
  const ask = video && !onBoard ? video : null;
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void judgeVideo(ask).then((playback) => {
      if (live) setJudged({ assetId: ask.assetId, playback });
    });
    return () => {
      live = false;
    };
    // One question per video: its facts never change under one id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.assetId]);
  if (!video) return null;
  if (onBoard) return onBoard;
  return judged && judged.assetId === assetId ? judged.playback : null;
}

/** The board's playback when the board handles this very video, else null. */
export function boardPlayback(board: BoardVideo, video: Pick<MapVideo, "assetId"> | null | undefined): Playback | null {
  return board && video && board.assetId === video.assetId ? board.playback : null;
}
