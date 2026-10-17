import { useEffect, useState } from "react";
import type { Effect } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { Switch } from "../../components/Switch.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { useSend, useSendAll } from "./hooks.ts";
import { fireOps, MAX_TRIGGER, readyOp, type ReactionTarget } from "./ready.ts";

/**
 * A row's Ready action (features section 10), for the DM and the creature's
 * owner: ready one with its trigger, then spend the Reaction when the
 * trigger happens, or let it go. A player's ops on the row wait for the
 * server (design 7.4), so the buttons spin until it answers.
 *
 * Players see only that a creature no player owns readied, not its trigger
 * (a design decision), so on such a creature the DM may show it to them.
 */
export function ReadyControls(props: { answer: ReactionTarget; target: ActorTarget; readied: Effect | undefined; dm: boolean; playerOwned: boolean }) {
  const { answer, target, readied } = props;
  const actions = useRoomActions();
  const ready = useSend();
  const fire = useSendAll();
  const drop = useSend();
  const [trigger, setTrigger] = useState("");
  // A trigger typed and not yet readied keeps the sheet from a swipe's close (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(trigger.trim() !== "");
  // "Drop it" takes two taps, like ending the fight: a player cannot undo it, and the marker is gone for good.
  const [confirmDrop, setConfirmDrop] = useState(false);
  useEffect(() => {
    if (!confirmDrop) return;
    const t = setTimeout(() => setConfirmDrop(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDrop]);

  if (readied) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
        <Help style={{ overflowWrap: "anywhere" }}>
          Holding a Ready action{readied.label ? `: ${readied.label}` : ""}. It ends when its next turn starts.
        </Help>
        {props.dm && !props.playerOwned && readied.label ? (
          <Switch
            label="Show the trigger to players"
            help="Otherwise they see only that it readied"
            checked={readied.triggerShown === true}
            onChange={(triggerShown) => actions.dispatch({ t: "actor.effect.update", target, effectId: readied.id, patch: { triggerShown } })}
          />
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
          {/* Secondary: the tracker's one primary is Next (docs/design-v1-visual.md 3.3). */}
          <Button size="sm" busy={fire.waiting} onClick={() => fire.send(fireOps({ target, effectId: readied.id, answer }))}>
            It fired: Reaction used
          </Button>
          <Button
            size="sm"
            variant="danger"
            armed={confirmDrop}
            busy={drop.waiting}
            onClick={() => {
              if (!confirmDrop) {
                setConfirmDrop(true);
                return;
              }
              setConfirmDrop(false);
              drop.send({ t: "actor.effect.remove", target, effectId: readied.id });
            }}
          >
            {confirmDrop ? "Tap again to drop it" : "Drop it"}
          </Button>
        </div>
      </div>
    );
  }

  const submit = () => {
    ready.send(readyOp({ target, answer, trigger, id: actions.newId() }));
    setTrigger("");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      style={{ display: "flex", gap: theme.space(1) }}
    >
      <Input
        aria-label="Trigger for the Ready action"
        value={trigger}
        maxLength={MAX_TRIGGER}
        placeholder="Trigger, such as “if the door opens”"
        enterKeyHint="done"
        onChange={(e) => setTrigger(e.target.value)}
        style={{ flex: 1 }}
      />
      <Button size="sm" busy={ready.waiting} onClick={submit} style={{ flex: "none" }}>
        Ready
      </Button>
    </form>
  );
}
