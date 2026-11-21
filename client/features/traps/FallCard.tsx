import { useEffect, useRef, useState } from "react";
import type { Fall } from "#shared/model.ts";
import { sameScene } from "#shared/rules/floors.ts";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { useDelayed } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { focusMap, mapFocusSlot } from "../../pages/mapFocus.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useLabels } from "../../state/labels.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { fallFill } from "../dice/groupSave/fills.ts";
import { ReplaceConfirm } from "../dice/groupSave/ReplaceConfirm.tsx";
import { useStartGroupSave, type StartInput } from "../dice/groupSave/start.ts";
import { FALL_CARD_ATTR } from "../floors/ids.ts";
import { cardStyle } from "../rolls/parts.tsx";
import { Note } from "../tokens/ui.tsx";
import { fallRead, type FallNames } from "./desk.ts";

/** The names this device read off fall cards' creatures, so one moved to another scene stays named (desk.ts FallNames). */
const KNOWN: FallNames = new Map();

/**
 * The group save a fall card's Apply starts (docs/design/design-v1-floors.md
 * phase 4, 4.4): a row for each creature it names that the DM's copy holds
 * (desk.ts fallers), the one that fell and the riders that fell with it
 * (D-261120-007), on the floor the first stands on now, and Apply removes
 * the card.
 */
export function fallStart(card: Fall, tokenIds: readonly string[]): StartInput {
  return { source: { kind: "fall", fallId: card.id, tokenIds: [...tokenIds] }, ...fallFill(card), panel: "dice" };
}

/** The title every fall card carries. */
export const FALL_TITLE = "Fall";

/**
 * A creature that fell through an opening, with the riders that fell with
 * it, waiting for the DM on the DM desk (docs/design/design-v1-floors.md
 * phase 4, 4.4): "Thorn fell 10 ft to Ground floor: 1d6 Bludgeoning,
 * Prone." Apply opens the group save filled as the fall reads, a row for
 * each, whose Apply removes the card, and Dismiss removes it
 * unapplied. A fall under 10 ft deals no damage and offers Dismiss alone.
 * A card whose creature landed on another scene offers Show, which goes
 * there, since the DM's copy holds that creature only then, and one whose
 * creature left the scene shown, moved to another scene or off the map,
 * offers Dismiss alone, until the DM shows the scene it stands on.
 *
 * Dismiss and Show wait for their answer: busy at once to a second tap, the
 * spinner after the room's usual 200 ms, and a plain error where it fails.
 * Once a dismissed card goes, the desk moves focus on (DmDesk.tsx), and Show
 * hands focus to the board once the floor shows.
 */
export function FallCard(props: { card: Fall; open: boolean; onToggle(): void; toggleRef(el: HTMLButtonElement | null): void; onDismiss(): void }) {
  const { card } = props;
  const labels = useLabels();
  const actions = useRoomActions();
  const scope = useRoomScope();
  const shown = useRoomView((s) => s.sceneId);
  const view = useRoomView((s) => s.view);
  const [busy, setBusy] = useState<"dismiss" | "show" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const late = useDelayed(busy !== null);
  // Show waits for the floor it asked for, whose scene's snapshot may still be on its way, then gives the board focus.
  // A switch elsewhere meanwhile, the DM's own, ends the wait too, since a later pick wins (RoomActions.switchScene).
  const from = useRef<string | null>(null);
  const arrived = busy === "show" && view !== null && shown !== null && sameScene(view, shown, card.sceneId);
  const left = busy === "show" && shown !== from.current && !arrived;
  useEffect(() => {
    if (!arrived && !left) return;
    setBusy(null);
    if (arrived) focusMap(scope.get(mapFocusSlot));
  }, [arrived, left, scope]);
  if (!view) return null;
  const read = fallRead(view, card, shown, labels, KNOWN);

  const dismiss = () => {
    if (busy !== null) return;
    setError(null);
    setBusy("dismiss");
    props.onDismiss();
    const n = actions.dispatch(
      { t: "fall.settle", fallId: card.id },
      {
        quiet: true,
        onAnswer: (answer, refusal) => {
          setBusy(null);
          if (answer === "refused") setError(refusal?.text || refusal?.message || "It was refused.");
          else if (answer === "unknown") setError("This may have happened. Check the log.");
        },
      },
    );
    if (n === null) {
      setBusy(null);
      setError("This needs a connection.");
    }
  };
  const show = () => {
    if (busy !== null) return;
    setError(null);
    from.current = shown;
    setBusy("show");
    actions.switchScene(card.sceneId);
  };

  return (
    <section role="region" aria-label={read.region} {...{ [FALL_CARD_ATTR]: card.id }} style={{ ...cardStyle, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <button
        ref={props.toggleRef}
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.open}
        style={{
          minWidth: 0,
          minHeight: theme.touch,
          display: "flex",
          alignItems: "center",
          gap: theme.space(1),
          padding: 0,
          background: "transparent",
          border: "none",
          color: theme.color.text,
          fontFamily: theme.font.body,
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <Icon name={props.open ? "chevronDown" : "chevronRight"} size="sm" />
        <span style={{ flex: 1, minWidth: 0, fontWeight: theme.weight.bold, fontSize: theme.font.body14 }}>{FALL_TITLE}</span>
      </button>
      {props.open ? (
        <>
          <span style={{ fontSize: theme.font.small }}>{read.line}</span>
          {saving ? <FallSaveStart card={card} tokenIds={read.tokenIds} onDone={() => setSaving(false)} /> : null}
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
            {read.kind === "here" && read.dice > 0 ? (
              <Button size="sm" variant="primary" aria-label={`Apply ${read.whose}`} onClick={() => setSaving(true)}>
                Apply
              </Button>
            ) : null}
            {read.kind === "elsewhere" ? (
              <Button size="sm" busy={late && busy === "show"} aria-busy={busy === "show" ? true : undefined} onClick={show}>
                Show
              </Button>
            ) : null}
            <Button size="sm" busy={late && busy === "dismiss"} aria-busy={busy === "dismiss" ? true : undefined} aria-label={`Dismiss ${read.whose}`} onClick={dismiss}>
              Dismiss
            </Button>
          </div>
          {error ? (
            <div role="alert">
              <Note tone="error">{error}</Note>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/**
 * Apply from a fall card: starts the group save at once, or asks first when
 * the open one holds rolls (ReplaceConfirm), as a trap's Save and damage
 * does. One group save at a time.
 */
function FallSaveStart(props: { card: Fall; tokenIds: readonly string[]; onDone(): void }) {
  const start = useStartGroupSave();
  const [pending, setPending] = useState<StartInput | null>(null);
  useEffect(() => {
    const input = fallStart(props.card, props.tokenIds);
    if (start(input)) props.onDone();
    else setPending(input);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pending) return null;
  return (
    <ReplaceConfirm
      onDiscard={() => {
        if (start(pending, { replace: true })) props.onDone();
      }}
      onKeep={props.onDone}
    />
  );
}
