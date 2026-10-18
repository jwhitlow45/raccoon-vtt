import { useState } from "react";
import type { Actor } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { Segmented } from "../../components/Segmented.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { MAX_HP_AMOUNT } from "./hpInput.ts";
import { FieldRow, Note, NumberField, Section, SmallButton } from "./ui.tsx";

type Kind = "short" | "long";

const KINDS: { value: Kind; label: string }[] = [
  { value: "short", label: "Short Rest" },
  { value: "long", label: "Long Rest" },
];

/**
 * Short and long rests (features section 15, shared/rules/rest.ts), for the
 * DM and the creature's owner. Rolling dice is the player's, so a short
 * rest asks for the HP the Hit Point Dice gave, and the app keeps no count
 * of those dice. Each rest is one tap more after choosing it, so a stray
 * tap never resets a creature.
 *
 * Rolling Initiative stops a rest (SRD 5.2.1 "Short Rest", "Long Rest"),
 * but a table may still want one mid-fight, after a skip ahead or for a
 * creature far from it, so a running fight only says so, once a rest is
 * chosen.
 */
export function RestSection(props: { actor: Pick<Actor, "hp" | "life"> | undefined; target: ActorTarget }) {
  const actions = useRoomActions();
  const [kind, setKind] = useState<Kind | null>(null);
  const [heal, setHeal] = useState<number | null>(null);
  const hp = props.actor?.hp;
  const canRest = !!hp && hp.cur >= 1 && props.actor?.life === "alive";
  // A rest chosen and not yet finished keeps the sheet from a swipe's close: only its button sends it (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(canRest && kind !== null);
  const fighting = useRoomView((s) => !!s.view?.encounter);

  const finish = () => {
    if (kind === "short") actions.dispatch({ t: "actor.rest", target: props.target, kind, ...(heal !== null && heal > 0 ? { heal } : {}) });
    if (kind === "long") actions.dispatch({ t: "actor.rest", target: props.target, kind });
    setKind(null);
    setHeal(null);
  };

  return (
    <Section title="Rest">
      {!canRest ? <Note>A rest needs at least 1 Hit Point.</Note> : null}
      {/* A tap on the chosen rest keeps it, as with any radio. Cancel below puts the choice away. */}
      <Segmented<Kind> label="Rest" value={kind} options={KINDS} disabled={!canRest} onChange={setKind} grow />
      {/* Only once a rest is chosen, so it adds nothing to every creature's panel during a fight (docs/design-v1-token-panel.md 3.8). */}
      {canRest && fighting && kind ? <Note>A fight is running, and rolling Initiative stops a rest. End the fight first, or rest anyway.</Note> : null}
      {canRest && kind === "short" ? (
        <>
          <Note>Roll each Hit Point Die you spend and add your Constitution modifier, at least 1 HP a die. Keep count of the dice on your sheet.</Note>
          <FieldRow label="HP regained">
            <NumberField label="HP regained from Hit Point Dice" value={heal ?? undefined} min={0} max={MAX_HP_AMOUNT} nullable placeholder="0" onCommit={setHeal} />
          </FieldRow>
        </>
      ) : null}
      {canRest && kind === "long" ? (
        <Note>All HP back, Temporary HP gone, one less Exhaustion level, and Legendary Resistance reset. Spell slots and features are on your sheet.</Note>
      ) : null}
      {canRest && kind ? (
        <div style={{ display: "flex", gap: theme.space(2) }}>
          <SmallButton tone="primary" grow onClick={finish}>
            {kind === "short" ? "Finish the Short Rest" : "Finish the Long Rest"}
          </SmallButton>
          <SmallButton onClick={() => setKind(null)}>Cancel</SmallButton>
        </div>
      ) : null}
    </Section>
  );
}
