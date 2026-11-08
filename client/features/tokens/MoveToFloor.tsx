import { useId, useMemo, useState } from "react";
import type { Token } from "#shared/model.ts";
import { Spinner } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { FLOOR_ROOT_ATTR, FLOOR_ROOTS } from "../floors/ids.ts";
import { floorChoices, moveToFloorOps } from "./moveToFloor.ts";

/** The words of the action bar's button and the More sheet's section: the bar says "Floor…" where its row is short. */
export const MOVE_TO_FLOOR = "Move to floor…";
export const MOVE_TO_FLOOR_SHORT = "Floor…";
export const MOVING_TO_FLOOR = "Moving…";

/** Whether the creatures stand on a scene with more than one floor, which is when Move to floor is offered. */
export function useOffersMoveToFloor(tokens: readonly Pick<Token, "sceneId">[]): boolean {
  return useRoomView((s) => {
    const first = tokens[0];
    const scene = first ? s.view?.scenes[first.sceneId] : undefined;
    return scene?.floor !== undefined && tokens.every((t) => s.view?.scenes[t.sceneId]?.floor?.of === scene.floor?.of);
  });
}

/**
 * The floors the DM can move the creatures to, one row each, top first
 * (docs/design/design-v1-floors.md 7.4). A row is a 44 px button named for the floor. Its second line
 * says why it is off ("Outside Attic"), or warns that the move opens a floor
 * to players. A move is one undo step and shows the floor it went to. While
 * it waits for the server every row is busy and refuses another tap.
 */
export function MoveToFloorList(props: { tokens: readonly Token[]; onMoved?(): void }) {
  const actions = useRoomActions();
  const view = useRoomView((s) => s.view);
  const [moving, setMoving] = useState<string | null>(null);
  const listId = useId();
  const choices = useMemo(() => (view ? floorChoices(view, props.tokens) : []), [view, props.tokens]);
  if (!view) return null;

  const go = (floorId: string) => {
    const choice = choices.find((c) => c.floor.id === floorId);
    if (!choice || choice.off !== null || moving !== null) return;
    const ops = moveToFloorOps(view, props.tokens, choice.floor);
    if (ops.length === 0) return;
    const group = ops.length > 1 ? actions.newId() : undefined;
    let waiting = 0;
    const settle = () => {
      if (--waiting > 0) return;
      setMoving(null);
      props.onMoved?.();
    };
    setMoving(floorId);
    for (const op of ops) {
      waiting += 1;
      if (actions.dispatch(op, { ...(group !== undefined ? { group } : {}), onAnswer: settle }) === null) settle();
    }
    // The DM's view follows the creatures it moved (7.3).
    actions.showFloor(floorId);
  };

  return (
    <div {...{ [FLOOR_ROOT_ATTR]: FLOOR_ROOTS.moveList }} role="group" aria-label={MOVE_TO_FLOOR.replace("…", "")} style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      {choices.length === 0 ? <p style={{ margin: 0, fontSize: theme.font.small, color: theme.color.textMuted }}>No other floor to move to.</p> : null}
      {choices.map((c) => {
        const line = c.off ?? c.warning;
        const lineId = `${listId}-${c.floor.id}`;
        const busy = moving === c.floor.id;
        return (
          <button
            key={c.floor.id}
            type="button"
            disabled={c.off !== null || (moving !== null && !busy)}
            aria-busy={busy || undefined}
            aria-describedby={line ? lineId : undefined}
            onClick={() => go(c.floor.id)}
            style={{
              minHeight: theme.touch,
              display: "flex",
              alignItems: "center",
              gap: theme.space(2),
              padding: `${theme.space(1)}px ${theme.space(3)}px`,
              borderRadius: theme.radius.md,
              border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
              background: theme.color.surfaceRaised,
              color: c.off !== null ? theme.color.textDisabled : theme.color.text,
              fontFamily: theme.font.body,
              textAlign: "left",
              cursor: c.off !== null || moving !== null ? "default" : "pointer",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
              <span style={{ overflowWrap: "anywhere", fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>{c.name}</span>
              {line ? (
                <span id={lineId} style={{ overflowWrap: "anywhere", fontSize: theme.font.small, lineHeight: theme.leading.body, color: c.off !== null ? theme.color.textDisabled : theme.color.warning }}>
                  {line}
                </span>
              ) : null}
            </span>
            {busy ? (
              <span style={{ display: "flex", alignItems: "center", gap: theme.space(1), fontSize: theme.font.small }}>
                <Spinner size={16} />
                {MOVING_TO_FLOOR}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
