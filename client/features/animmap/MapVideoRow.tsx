import { useCallback, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { MapVideo, Scene, SceneMap } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Loading } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { LOW_POWER_STOPPED, NO_FIRST_FRAME } from "./firstFrame.ts";
import { VideoHold, type AnimatedUpload, type UploadStep } from "./upload.ts";
import { useVideoPlayback } from "./useVideoPlayback.ts";
import { playbackLine, USE_STILL_ONLY, videoRowHelp } from "./words.ts";

/**
 * The DM's side of an animated map in the scene's settings
 * (docs/design/design-v1-animated-maps.md 4.1 and 4.2): the Map image row's
 * help and this device's playback line, Use the still only, and the form
 * that asks for a still image when this device cannot read the first frame.
 */

/** The Map image row's help for an animated map, with this device's line under it, muted. */
export function MapVideoHelp(props: { video: MapVideo }) {
  const playback = useVideoPlayback(props.video);
  return (
    <>
      <span style={{ display: "block" }}>{videoRowHelp(props.video)}</span>
      <span data-animmap-line="" style={{ display: "block" }}>
        {playback ? playbackLine(playback, props.video) : <Loading small live={false} text="Checking this device…" />}
      </span>
    </>
  );
}

/** Drops the video and keeps the still as a plain map, as one Setup history step (scene.setMap is a setup op). */
export function UseStillOnly(props: { scene: Scene; disabled?: boolean }) {
  const actions = useRoomActions();
  const map = props.scene.map;
  if (!map?.video) return null;
  return (
    <Button
      size="sm"
      disabled={props.disabled}
      onClick={() => actions.dispatch({ t: "scene.setMap", sceneId: props.scene.id, map: stillOnly(map) })}
    >
      {USE_STILL_ONLY}
    </Button>
  );
}

/** The map as it is, without its video: the still, its grid kept. */
export function stillOnly(map: SceneMap): SceneMap {
  const { video: _dropped, ...still } = map;
  return still;
}

/** A video waiting for a still the DM picks, after the first frame could not be read. `problem` is a still that did not fit. */
export type PendingStill = { file: File; lowPower: boolean; problem: string | null };

/**
 * The upload's own state beside a form's: the probe's host, the video a
 * still pick waits on, and the clean-up the design asks for. A video this
 * upload made is deleted when the form cancels it or goes away before the
 * map takes it, and `taken` hands it to the map once the op is sent.
 */
export function useVideoUpload(roomId: string) {
  const host = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState<PendingStill | null>(null);
  const room = useRef(roomId);
  room.current = roomId;
  /** This upload's video, from its upload until the map takes it or the form lets it go (upload.ts VideoHold). */
  const [hold] = useState(() => new VideoHold(() => room.current));
  useEffect(() => () => hold.release(), [hold]);

  /**
   * Runs the steps for a picked video, for its still once picked, or again
   * for its stored copy's frame on Try again. Null when the form must ask
   * for a still first (`pending` says why).
   */
  const run = useCallback(
    async (file: File, options: { signal: AbortSignal; onStep(step: UploadStep): void; onWaiting?: (waiting: boolean) => void; still?: File }): Promise<AnimatedUpload | null> => {
      setPending(null);
      const outcome = await hold.run({ roomId: room.current, file, host: host.current, ...options });
      if (outcome.t === "done") return outcome.upload;
      setPending({ file, lowPower: outcome.lowPower, problem: outcome.problem });
      return null;
    },
    [hold],
  );

  /** The map took the video: it is no longer this upload's to delete. */
  const taken = useCallback(() => hold.taken(), [hold]);

  /** The DM let the upload go: a video it made goes too. */
  const cancel = useCallback(() => {
    setPending(null);
    hold.release();
  }, [hold]);

  return { host, pending, run, taken, cancel };
}

/**
 * Where the first-frame probe sits: in the form, 1 × 1 px, so it works
 * before any scene or board exists. Hidden from screen readers with it.
 */
export function ProbeHost(props: { host: RefObject<HTMLDivElement | null> }) {
  return <div ref={props.host} aria-hidden style={PROBE_HOST} />;
}

// Out of the form's flow, so it adds no gap to the column it sits in.
const PROBE_HOST: CSSProperties = { position: "absolute", left: 0, top: 0, width: 1, height: 1, overflow: "hidden", pointerEvents: "none" };

/**
 * When this device cannot read the first frame (4.1): the reason, Pick a
 * still image, and, after iOS Low Power Mode refused `play()`, Try again,
 * whose tap allows `play()`. A still of the wrong shape says so here too.
 */
export function StillPick(props: { pending: PendingStill; busy: boolean; onStill(file: File): void; onRetry(): void }) {
  const { pending } = props;
  return (
    <div style={{ display: "grid", gap: theme.space(2), justifyItems: "start" }}>
      <p role="alert" style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.text, overflowWrap: "anywhere" }}>
        {pending.problem ?? (pending.lowPower ? LOW_POWER_STOPPED : NO_FIRST_FRAME)}
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        <label style={{ ...PICKER, cursor: props.busy ? "default" : "pointer", ...buttonLook("secondary", { disabled: props.busy }) }}>
          Pick a still image
          <input
            type="file"
            accept="image/*"
            disabled={props.busy}
            style={{ position: "absolute", inset: 0, opacity: 0, width: "100%", cursor: props.busy ? "default" : "pointer" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) props.onStill(f);
            }}
          />
        </label>
        {pending.lowPower && !pending.problem ? (
          <Button size="sm" disabled={props.busy} onClick={props.onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A label over a file input wears the small secondary button's look, as the Map image row's own picker does. */
export const PICKER: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: theme.space(2),
  minHeight: theme.touch,
  padding: `0 ${theme.space(3)}px`,
  borderRadius: theme.radius.md,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
};

/**
 * A video where a picture would be (4.6): a strip of film on the surface's
 * raised color, its holes in the border color, since a video has no small
 * copy of its own (D-261102-456). The Library's tile and the viewer's page
 * under Still both draw it.
 */
export function FilmStrip(props: { style?: CSSProperties }) {
  const holes = `repeating-linear-gradient(90deg, ${theme.color.border} 0 6px, transparent 6px 12px)`;
  const band: CSSProperties = { flex: "none", height: 8, margin: "4px 6px", background: holes, borderRadius: theme.radius.sm };
  return (
    <span aria-hidden style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: theme.color.surfaceRaised, ...props.style }}>
      <span style={band} />
      <span style={{ flex: 1, margin: "0 6px", border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.sm }} />
      <span style={band} />
    </span>
  );
}
