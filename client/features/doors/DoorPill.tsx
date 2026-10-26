import { useEffect, useMemo } from "react";
import { useStore } from "zustand";
import type { BuildChunk, FogTile, Scene, Token } from "#shared/model.ts";
import { DOOR_TOO_FAR, reachesDoor } from "#shared/permissions.ts";
import { Button } from "../../components/Button.tsx";
import { PaneHeader } from "../../components/SheetHeader.tsx";
import { viewToScreen, type Camera, type Insets, type Size } from "../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";
import { theme } from "../../lib/theme.ts";
import { localDragSlot } from "../../state/localDrags.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { cardPlace } from "../movement/anchor.ts";
import { ownsToken } from "../tokens/access.ts";
import { doorActions, doorName, pillOpener, seenDoor, type DoorOnMap } from "./doors.ts";
import { doorPillSlot } from "./store.ts";

const EMPTY_CHUNKS: Readonly<Record<string, BuildChunk>> = {};
const EMPTY_FOG: Readonly<Record<string, FogTile>> = {};
/** The card's height, for where it fits: its 48 px name row, a 44 px row of buttons, the gap between them and its padding. */
const PILL_HEIGHT = 48 + 44 + theme.space(1) + 2 * theme.space(2);

/**
 * A door's pill (docs/design-v1-maps-vision.md 4.1), over the door a tap
 * reached with the Select tool: Open or Close, and for the DM Lock or
 * Unlock, and Mark found or Hide on a secret door. It reads the door from
 * this viewer's own view, so it follows the door as it changes and goes
 * when the door does or the fog covers it, when another tool is picked,
 * or when a token is tapped, whose bar takes its place. It steps aside
 * while a token is dragged, so it never covers where the token goes.
 */
export function DoorPillHost(props: { scene: Scene; tool: string; camera: Camera; viewport: Size; insets: Insets }) {
  const slot = useScoped(doorPillSlot);
  const pill = useStore(slot, (s) => s.pill);
  const chunks = useRoomView((s) => s.view?.buildChunks ?? EMPTY_CHUNKS);
  const role = useRoomView((s) => s.you?.role ?? "player");
  const tokenSelected = useRoomView((s) => s.local.selectedId !== null);
  const dragging = useStore(useScoped(localDragSlot), (s) => Object.keys(s.spots).length > 0);
  const fogTiles = useRoomView((s) => s.view?.fogTiles ?? EMPTY_FOG);
  // The fog a player's tap is held to (tap.ts), so a pill goes once the DM's fog covers its door again.
  const fog = role === "player" && props.scene.fogEnabled !== false ? fogTiles : null;
  const door = useMemo(() => (pill && pill.sceneId === props.scene.id ? seenDoor(chunks, pill.sceneId, pill.ref, fog) : null), [pill, chunks, fog, props.scene.id]);
  const open = door !== null && props.tool === "select" && !tokenSelected;
  useEffect(() => {
    if (pill && !open) slot.setState({ pill: null });
  }, [pill, open, slot]);
  if (!open || !door || dragging) return null;
  return <Pill door={door} selected={pill?.selected} scene={props.scene} role={role} camera={props.camera} viewport={props.viewport} insets={props.insets} />;
}

function Pill(props: { door: DoorOnMap; selected: string | undefined; scene: Scene; role: "dm" | "player"; camera: Camera; viewport: Size; insets: Insets }) {
  const { door, scene, role } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  // Who opens it, whose door traps it sets off (docs/design-v1-traps.md 5.3).
  const opener = (): string | undefined => {
    const s = store.getState();
    const view = s.view;
    if (!view) return undefined;
    return pillOpener(view, s.you, door, scene.id, props.selected, (t) => ownsToken(view, s.you?.memberId, t));
  };
  const choices = doorActions(scene.id, door, role);
  const width = Math.min(role === "dm" ? 300 : 160, props.viewport.width - 16);
  const anchor = viewToScreen(props.camera, toView(TOP_DOWN, door.mid));
  const place = cardPlace({ anchor, viewport: props.viewport, insets: props.insets, width, height: PILL_HEIGHT, gap: 14, prefer: "above" });
  const name = doorName(door, role);

  /*
   * A player's door must be within reach of a token of theirs, which the
   * server checks. Asking the same rule here first says "Too far" at once,
   * instead of the door swinging open on this screen and back.
   */
  const reached = (): boolean => {
    const s = store.getState();
    const view = s.view;
    if (role === "dm" || !view) return true;
    return Object.values(view.tokens).some(
      (t): t is Token => !!t && t.sceneId === scene.id && ownsToken(view, s.you?.memberId, t) && reachesDoor(view, t, door.ref, door.chunk),
    );
  };

  return (
    <div
      role="group"
      aria-label={name}
      style={{
        position: "absolute",
        left: place.left,
        top: place.top,
        width,
        zIndex: theme.z.pane,
        display: "grid",
        gap: theme.space(1),
        padding: `0 ${theme.space(2)}px ${theme.space(2)}px`,
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        boxShadow: theme.shadow.pane,
        color: theme.color.text,
      }}
    >
      <PaneHeader title={name} />
      <div style={{ display: "flex", gap: theme.space(1) }}>
        {choices.map((choice) => (
          <Button
            key={choice.label}
            size="sm"
            onClick={() => {
              if (!reached()) {
                ui.notify(DOOR_TOO_FAR);
                return;
              }
              const by = choice.op.state === "open" ? opener() : undefined;
              actions.dispatch(by !== undefined ? { ...choice.op, by } : choice.op);
            }}
            style={{ flex: 1, padding: `0 ${theme.space(2)}px`, whiteSpace: "nowrap" }}
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
