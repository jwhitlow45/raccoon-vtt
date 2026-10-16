import type { LifeState, TokenKind } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { handFocusOn } from "../../lib/handFocus.ts";
import { useRoomActions } from "../../state/view.ts";

/**
 * The DM's Revive where a tap lands (docs/design-v1-combat-flow.md 3.5): in
 * a dead creature's action bar beside its Dead tag, and first in its
 * tracker row's options. The token panel keeps its own beside Stabilize and
 * Mark dead.
 */

/** The visible line under Revive that is its description, so nothing depends on a tooltip. */
export const REVIVE_NOTE = "Revive brings it back with 1 HP.";

/**
 * Whether a creature offers Revive: dead, and not an object. No HP rule
 * kills an object, so only an older state or a hand-made import leaves one
 * dead, and the map shows nothing of it (3.6.6).
 */
export function offersRevive(life: LifeState | undefined, kind: TokenKind | undefined): boolean {
  return life === "dead" && kind !== "object";
}

/**
 * Sends `actor.life` `alive`, which the DM's device predicts at once. Its
 * name is its text, its description the line `describedBy` names. It goes
 * with the death it undoes, so focus moves to the first of `focusTo.to`
 * inside its closest `focusTo.scope`, such as the bar's frame.
 */
export function ReviveButton(props: { target: ActorTarget; describedBy: string; focusTo: { scope: string; to: readonly string[] } }) {
  const actions = useRoomActions();
  return (
    <Button
      size="sm"
      aria-describedby={props.describedBy}
      onClick={(e) => {
        const scope = e.currentTarget.closest<HTMLElement>(props.focusTo.scope);
        if (actions.dispatch({ t: "actor.life", target: props.target, life: "alive" }) !== null) handFocusOn(scope, props.focusTo.to);
      }}
    >
      Revive
    </Button>
  );
}
