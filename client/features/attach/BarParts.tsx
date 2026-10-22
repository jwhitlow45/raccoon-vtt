import { Fragment, useId, useMemo } from "react";
import type { Token } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { barSlots, DETACH_WORDS, detachChoice, detachOp, getOffPlace, holderAction, NO_ROOM_TO_GET_OFF } from "./detach.ts";
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

/**
 * Get off, Put down or Let go, on a carried token's bar before its Attach
 * (4.3). Get off finds its spot beside the holder as this viewer sees the
 * room (detach.ts getOffPlace), and without one it is disabled, with why
 * under it.
 */
export function DetachButton(props: { token: Token }) {
  const { token } = props;
  const actions = useRoomActions();
  const viewer = useAttachViewer();
  const view = useRoomView((s) => s.view);
  const noteId = useId();
  const choice = view ? detachChoice(view.tokens, token) : null;
  const place = useMemo(() => (view && choice === "getOff" ? getOffPlace(view, viewer, token) : null), [view, viewer, token, choice]);
  if (!view || !choice) return null;
  const stuck = choice === "getOff" && place === null;
  return (
    <span style={{ display: "inline-grid", gap: theme.space(0.5), flex: "none" }}>
      <Button size="sm" disabled={stuck} aria-describedby={stuck ? noteId : undefined} onClick={() => actions.dispatch(detachOp(token.id, place))}>
        {DETACH_WORDS[choice]}
      </Button>
      {stuck ? (
        <span id={noteId} style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
          {NO_ROOM_TO_GET_OFF}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The group line in the bar's summary (4.4): "On Warhorse" or "Dragged by
 * Thorn" on a carried token, and on a holder what it carries, each a
 * button that selects that token, so a phone reaches a rider that hides
 * its mount, or a familiar too small to tap. Beside each creature a
 * holder drags or carries, Let go, and beside each object, Put down, for
 * whoever may undo the link.
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
  return (
    <div role="group" aria-label="Attached tokens" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
      {line.holder ? (
        <Button size="sm" onClick={() => ui.select(line.holder!.id)} style={{ flex: "none" }}>
          {line.holder.text}
        </Button>
      ) : null}
      {line.carried.length > 0 ? (
        <span aria-hidden style={{ color: theme.color.textMuted }}>
          Carrying
        </span>
      ) : null}
      {line.carried.map((c) => {
        const action = holderAction(c.token);
        return (
          <Fragment key={c.id}>
            <Button size="sm" aria-label={`Carrying ${c.name}`} onClick={() => ui.select(c.id)} style={{ flex: "none" }}>
              {c.name}
            </Button>
            {action && detachAllowed(view, viewer, c.token) ? (
              <Button size="sm" onClick={() => actions.dispatch(detachOp(c.id, null))} style={{ flex: "none" }}>
                {action.words}
              </Button>
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
