import { Fragment, useMemo } from "react";
import type { Token } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { barSlots, DETACH_WORDS, detachChoice, detachOp, getOffPlace, holderAction, NO_ROOM_TO_GET_OFF, type DetachChoice } from "./detach.ts";
import { groupLine } from "./groups.ts";
import { detachAllowed, type AttachViewer } from "./rights.ts";

/** Who is looking, as the attach rules read it. */
export function useAttachViewer(): AttachViewer {
  const you = useRoomView((s) => s.you);
  return useMemo(() => ({ role: you?.role ?? "player", memberId: you?.memberId ?? null }), [you]);
}

/** What the bar's attach slots hold for this token (detach.ts barSlots). */
export function useAttachSlots(token: Token): ("detach" | "attach")[] {
  const viewer = useAttachViewer();
  const view = useRoomView((s) => s.view);
  return view ? barSlots(view, viewer, token) : [];
}

/** What undoes this token's link from its own bar, and for Get off its spot beside the holder, or none (`stuck`). */
export type DetachState = { choice: DetachChoice; place: { x: number; y: number; elevation: number } | null; stuck: boolean };

/**
 * The carried token's Get off, Put down or Let go (4.3), worked out once
 * for the bar's button and the note under its play row. Get off finds its
 * spot beside the holder as this viewer sees the room (detach.ts
 * getOffPlace), only while the bar `shows` the button. Null for a token on
 * no holder in this copy.
 */
export function useDetach(token: Token, shows: boolean): DetachState | null {
  const viewer = useAttachViewer();
  const view = useRoomView((s) => s.view);
  const choice = view && shows ? detachChoice(view.tokens, token) : null;
  const place = useMemo(() => (view && choice === "getOff" ? getOffPlace(view, viewer, token) : null), [view, viewer, token, choice]);
  if (!view || !choice) return null;
  return { choice, place, stuck: choice === "getOff" && place === null };
}

/**
 * Get off, Put down or Let go, on a carried token's bar before its Attach
 * (4.3). Without a spot to get off to, Get off is unavailable but keeps its
 * focus and its place in the keys' order (`aria-disabled`), described by
 * the note under the play row (DetachNote), which stands on a row of its
 * own so no button in the row stretches to the note's width
 * (docs/design-v1-look-pass-2.md 2.7).
 */
export function DetachButton(props: { token: Token; detach: DetachState | null; noteId: string }) {
  const actions = useRoomActions();
  const { detach } = props;
  if (!detach) return null;
  return (
    <Button
      size="sm"
      aria-disabled={detach.stuck ? true : undefined}
      aria-describedby={detach.stuck ? props.noteId : undefined}
      onClick={() => {
        if (!detach.stuck) actions.dispatch(detachOp(props.token.id, detach.place));
      }}
      // It stands only in the bar's play row, whose buttons grow to share their line (canvas/TokenActionBar.tsx ButtonRow).
      style={{ flex: "1 1 auto", ...(detach.stuck ? { ...buttonLook("secondary", { disabled: true }), cursor: "default" } : null) }}
    >
      {DETACH_WORDS[detach.choice]}
    </Button>
  );
}

/** Why Get off is unavailable, under the bar's play row, for DetachButton to point at. */
export function DetachNote(props: { detach: DetachState | null; id: string }) {
  if (!props.detach?.stuck) return null;
  return <Help id={props.id}>{NO_ROOM_TO_GET_OFF}</Help>;
}

/**
 * A button in the group line keeps to its cell: it may shrink to Button's
 * 44 px floor, and its words wrap, a single long word too, where a long
 * name would otherwise run past the window's edge.
 */
const IN_CELL = { flex: "0 1 auto", maxWidth: "100%", overflowWrap: "anywhere" } as const;

/** The words before a holder's tokens, what it carries and then what it drags. */
const HOLDS: Record<"carrying" | "dragging", string> = { carrying: "Carrying", dragging: "Dragging" };

/**
 * The group line in the bar's summary (4.4): "Riding Warhorse" or
 * "Dragged by Thorn" on a carried token, in the panel's words, and on a
 * holder "Carrying Bree, Torch" and "Dragging Goblin 2", each name a
 * button that selects that token, so a phone reaches a rider that hides
 * its mount, or a familiar too small to tap. Beside each creature a holder
 * drags or carries, Let go, and beside each object, Put down, for whoever
 * may undo the link. The name beside it already says which token, so they
 * show the short words, named in full for a reader ("Put down Torch").
 *
 * Each kind of link is a row of its own (docs/design-v1-polish.md R5): its
 * word in a first column as wide as the longer word, its names and actions
 * wrapping beside it. One wrapping row for both kinds ended a line on
 * "Dragging" with its names on the next, under the carried ones. With the
 * word's column taken, a long name keeps to its cell and wraps there, and
 * the word stands on its first name's first line, as rows meet on their
 * baseline.
 */
export function GroupLine(props: { token: Token }) {
  const { token } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const viewer = useAttachViewer();
  const view = useRoomView((s) => s.view);
  if (!view) return null;
  const line = groupLine(view.tokens, token);
  if (!line.holder && line.carried.length === 0) return null;
  const holds = (["carrying", "dragging"] as const).map((key) => ({ key, tokens: line.carried.filter((c) => c.dragged === (key === "dragging")) })).filter((h) => h.tokens.length > 0);
  return (
    <div role="group" aria-label="Attached tokens" style={{ display: "grid", gridTemplateColumns: "max-content minmax(0, 1fr)", alignItems: "baseline", gap: theme.space(1) }}>
      {line.holder ? (
        <Button size="sm" onClick={() => ui.select(line.holder!.id)} style={{ ...IN_CELL, gridColumn: "1 / -1", justifySelf: "start" }}>
          {line.holder.text}
        </Button>
      ) : null}
      {holds.map((h) => (
        <Fragment key={h.key}>
          <span aria-hidden data-hold-word={h.key} style={{ color: theme.color.textMuted }}>
            {HOLDS[h.key]}
          </span>
          <div data-hold-names={h.key} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
            {h.tokens.map((c) => {
              const action = holderAction(c.token);
              return (
                <Fragment key={c.id}>
                  <Button size="sm" aria-label={`${HOLDS[h.key]} ${c.name}`} onClick={() => ui.select(c.id)} style={IN_CELL}>
                    {c.name}
                  </Button>
                  {action && detachAllowed(view, viewer, c.token) ? (
                    <Button size="sm" aria-label={action.words} onClick={() => actions.dispatch(detachOp(c.id, null))} style={IN_CELL}>
                      {DETACH_WORDS[action.choice]}
                    </Button>
                  ) : null}
                </Fragment>
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
