import { useMemo } from "react";
import { useStore } from "zustand";
import type { Token, Viewer } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { useDelayed } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { handFocusWhenFound } from "../../lib/handFocus.ts";
import { useScoped } from "../../state/scope.ts";
import { useKeyHint } from "../../state/shortcuts.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { climbOffer, climbWaiting, climbWaitSlot, sendClimb, type ClimbOffer } from "./climb.ts";
import { CLIMB_ATTR } from "./ids.ts";
import { climbName, climbOffReason, climbTip, climbWords } from "./linkWords.ts";

/**
 * The offer of Go up or Go down for a creature's bar (docs/design/design-v1-floors.md
 * phase 2, 6.1), read on the board's copy of the floor shown, which holds
 * the creature, the ends on its floor and the ground under them.
 */
export function useClimbOffer(token: Token): ClimbOffer | null {
  const role = useRoomView((s) => s.you?.role ?? "player");
  const memberId = useRoomView((s) => s.you?.memberId ?? "");
  const links = useRoomView((s) => s.floorView?.floorLinks);
  const scenes = useRoomView((s) => s.floorView?.scenes);
  const tokens = useRoomView((s) => s.floorView?.tokens);
  const characters = useRoomView((s) => s.floorView?.characters);
  const meta = useRoomView((s) => s.floorView?.meta);
  const encounter = useRoomView((s) => s.floorView?.encounter ?? null);
  const chunks = useRoomView((s) => s.floorView?.buildChunks);
  return useMemo(() => {
    if (!links || !scenes || !tokens || !characters || !meta || !chunks) return null;
    const viewer: Viewer = { role, memberId };
    return climbOffer({ floorLinks: links, scenes, tokens, characters, meta, encounter, buildChunks: chunks }, viewer, token);
  }, [role, memberId, links, scenes, tokens, characters, meta, encounter, chunks, token]);
}

/**
 * Go up or Go down (6.2, 6.4): in the bar's passing row with its words, or
 * in the strip as its icon alone (`compact`). A press sends the climb
 * through the Room's one wait (climb.ts), shows busy at once and the
 * spinner after the room's usual 200 ms, and takes no second press until
 * the server answers. The device then follows the creature by phase 1's
 * rules, and focus goes to the other way's button where the press left
 * it on this one. Off, it keeps its place dim, names its reason by
 * `aria-describedby` (`noteId`, ClimbNote) and says it again on a press,
 * for the strip, which has no room for the note.
 */
export function ClimbButton(props: { token: Token; offer: ClimbOffer; compact?: boolean; noteId?: string }) {
  const { token, offer } = props;
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const wait = useScoped(climbWaitSlot);
  const waitState = useStore(wait);
  const waiting = useRoomView((s) => climbWaiting(waitState, s.pending));
  const late = useDelayed(waiting);
  // Each way's own row of state/shortcuts.ts CLIMB_SHORTCUTS, named whole so the shortcut table's test finds both.
  const keys = { up: useKeyHint("goUp"), down: useKeyHint("goDown") };
  const key = keys[offer.dir];
  const off = offer.off !== null;
  const other = offer.dir === "up" ? "down" : "up";
  const press = () => {
    if (offer.off !== null) {
      ui.notify(climbOffReason(offer.off, offer.kind));
      return;
    }
    if (!sendClimb({ wait, pending: store.getState().pending, dispatch: actions.dispatch }, token.id, offer.link.id)) return;
    // This button goes once the creature stands on the far end, and the other way's takes its place (13). The strip keeps the form it does not draw mounted and hidden.
    handFocusWhenFound(() => [...document.querySelectorAll<HTMLElement>(`[${CLIMB_ATTR}="${other}"]`)].find((el) => el.checkVisibility({ visibilityProperty: true })) ?? null);
  };
  return (
    <Button
      // A new element for each way, so the hand-off finds the other way's button rather than this one renamed.
      key={offer.dir}
      size="sm"
      icon="stairwell"
      iconOnly={props.compact ? "always" : undefined}
      busy={late}
      aria-busy={waiting ? true : undefined}
      aria-label={climbName(offer.dir, offer.kind, offer.floor)}
      aria-keyshortcuts={key?.aria}
      aria-disabled={off ? true : undefined}
      aria-describedby={off ? props.noteId : undefined}
      title={climbTip(offer.dir, offer.kind, key?.text ?? null)}
      {...{ [CLIMB_ATTR]: offer.dir }}
      onClick={press}
      // In the passing row it grows to share its line, as the row's buttons do (canvas/TokenActionBar.tsx ButtonRow). The strip's icon keeps its 44 px.
      style={{ flex: props.compact ? "none" : "1 1 auto", ...(off ? { ...buttonLook("secondary", { disabled: true }), cursor: "default" } : null) }}
    >
      {climbWords(offer.dir)}
    </Button>
  );
}

/** Why Go up or Go down is off, on a dim line under the bar's passing row (6.1), for ClimbButton to point at. */
export function ClimbNote(props: { offer: ClimbOffer | null; id: string }) {
  const off = props.offer?.off;
  if (off === undefined || off === null) return null;
  return <Help id={props.id}>{climbOffReason(off, props.offer!.kind)}</Help>;
}
