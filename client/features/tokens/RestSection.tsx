import { useState } from "react";
import { clockNow } from "#shared/calendar.ts";
import type { Actor, Character, ClassResource } from "#shared/model.ts";
import { hasSlots } from "#shared/rules/spellSlots.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { Segmented } from "../../components/Segmented.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { restNote } from "../clock/words.ts";
import { hiddenModules } from "../modules/gate.ts";
import { HiddenHere, useFeaturesHere } from "../modules/Gate.tsx";
import { restBackText } from "../resources/logic.ts";
import { HitDiceCount, HitDiceRows } from "../slots/HitDiceRows.tsx";
import { dieRows } from "../slots/logic.ts";
import { MAX_HP_AMOUNT } from "./hpInput.ts";
import { FieldRow, Note, NumberField, Section, SmallButton } from "./ui.tsx";

type Kind = "short" | "long";

const KINDS: { value: Kind; label: string }[] = [
  { value: "short", label: "Short Rest" },
  { value: "long", label: "Long Rest" },
];

/**
 * Short and long rests (features section 15, shared/rules/rest.ts), for the
 * DM and the creature's owner. For a creature without classes, rolling the
 * Hit Point Dice is the player's, so a short rest asks for the HP they gave
 * and the app keeps no count of them. A character with classes spends its
 * dice on the card's own rows instead (below). Each rest is one tap more
 * after choosing it, so a stray tap never resets a creature.
 *
 * Rolling Initiative stops a rest (SRD 5.2.1 "Short Rest", "Long Rest"),
 * but a table may still want one mid-fight, after a skip ahead or for a
 * creature far from it, so a running fight only says so, once a rest is
 * chosen.
 *
 * A character's class resources come back with the rest, so a chosen rest
 * names those it restores (docs/design/design-v1-combat-controls.md 7.2).
 *
 * With `character` and its classes (docs/design/design-v1-slots.md 3.3), a
 * count of its Hit Point Dice stands under the rest choice, and the Short
 * Rest card rolls them one at a time on the server's dice, each healing at
 * once, in place of the typed HP. Cancel after a roll keeps what the dice
 * did, and Finish restores what the rest restores, with no heal.
 *
 * Hit Point Dice hidden on this device take the count line and the dice
 * words, Spell slots the slot words, and the section's foot names them
 * with their Show (docs/design/design-v1-features.md 3 and 6, the rest
 * home). The Short Rest card's dice rows and Constitution field stay, so a
 * rest still spends the dice it rolls (D-261127-300).
 *
 * A rest of one creature never moves the room's clock, since two players
 * resting would move it twice. With a clock running, the DM's Long Rest
 * says when the character last finished one and the earliest next start
 * (docs/design/design-v1-calendar.md 4.5). The stamp is the DM's alone.
 */
export function RestSection(props: {
  actor: (Pick<Actor, "hp" | "life"> & Partial<Pick<Actor, "srdId">>) | undefined;
  target: ActorTarget;
  resources?: readonly ClassResource[];
  /** The character the creature plays, whose classes count its Hit Point Dice and spell slots. */
  character?: Character;
  /** The room search's anchors (features/search/entry.ts) on each rest's choice, where a creature's Long Rest is a result of its own: a character's page. */
  search?: { short: string; long: string; hitDice?: string };
}) {
  const actions = useRoomActions();
  const [kind, setKind] = useState<Kind | null>(null);
  const [heal, setHeal] = useState<number | null>(null);
  const hp = props.actor?.hp;
  const canRest = !!hp && hp.cur >= 1 && props.actor?.life === "alive";
  // A rest chosen and not yet finished keeps the sheet from a swipe's close: only its button sends it (docs/design/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(canRest && kind !== null);
  const fighting = useRoomView((s) => !!s.view?.encounter);
  const character = props.character;
  const here = useFeaturesHere();
  // With no role known the choices are Everything, which hides nothing.
  const hidden = hiddenModules(here.role ?? "dm", here.choices);
  const diceShown = !hidden.has("hitDice");
  const back = kind ? restBackText(props.resources, kind, character?.spent, hidden) : null;
  const dice = character ? dieRows(character).length > 0 : false;
  const slots = hasSlots(character?.classes) && !hidden.has("spellSlots");
  const tracked = (props.resources?.length ?? 0) > 0;
  const note = useRoomView((s) => {
    const clock = s.view?.clock;
    if (!clock || s.you?.role !== "dm" || kind !== "long") return null;
    const target = props.target;
    const token = "tokenId" in target ? s.view?.tokens[target.tokenId] : undefined;
    const characterId = "characterId" in target ? target.characterId : token?.actor && "ref" in token.actor ? token.actor.ref : undefined;
    const character = characterId === undefined ? undefined : s.view?.characters[characterId];
    if (!character) return null;
    return restNote({ name: character.name, stamp: character.longRest, clockId: clock.id, now: clockNow(clock, s.view?.encounter), calendar: clock.calendar, movesClock: false });
  });

  const finish = () => {
    if (kind === "short") actions.dispatch({ t: "actor.rest", target: props.target, kind, ...(!dice && heal !== null && heal > 0 ? { heal } : {}) });
    if (kind === "long") actions.dispatch({ t: "actor.rest", target: props.target, kind });
    setKind(null);
    setHeal(null);
  };

  return (
    <Section title="Rest">
      {!canRest ? <Note>A rest needs at least 1 Hit Point.</Note> : null}
      {/* A tap on the chosen rest keeps it, as with any radio. Cancel below puts the choice away. */}
      <Segmented<Kind> label="Rest" value={kind} options={props.search ? KINDS.map((k) => ({ ...k, search: props.search?.[k.value] })) : KINDS} disabled={!canRest} onChange={setKind} grow />
      {character && dice && diceShown ? <HitDiceCount character={character} search={props.search?.hitDice} /> : null}
      {/* Only once a rest is chosen, so it adds nothing to every creature's panel during a fight (docs/design/design-v1-token-panel.md 3.8). */}
      {canRest && fighting && kind ? <Note>A fight is running, and rolling Initiative stops a rest. End the fight first, or rest anyway.</Note> : null}
      {canRest && kind === "short" && character && dice ? (
        <>
          <Note>Spend Hit Point Dice one at a time. Each one heals at once.</Note>
          {back ? <Note tone="info">{back}</Note> : null}
          <HitDiceRows character={character} actor={props.actor} />
        </>
      ) : canRest && kind === "short" ? (
        <>
          <Note>{`Roll each Hit Point Die you spend and add your Constitution modifier, at least 1 HP a die. Keep count of the dice on your sheet${character ? ", or add your classes in Uses to count and roll them here." : "."}`}</Note>
          {back ? <Note tone="info">{back}</Note> : null}
          <FieldRow label="HP regained">
            <NumberField label="HP regained from Hit Point Dice" value={heal ?? undefined} min={0} max={MAX_HP_AMOUNT} nullable placeholder="0" onCommit={setHeal} />
          </FieldRow>
        </>
      ) : null}
      {canRest && kind === "long" ? (
        <>
          <Note>
            {dice
              ? `All HP back, ${diceShown ? "every spent Hit Point Die back, " : ""}${slots ? "every spell slot back, " : ""}Temporary HP gone, one less Exhaustion level, and Legendary Resistance reset.`
              : `All HP back, Temporary HP gone, one less Exhaustion level, and Legendary Resistance reset. Spell slots and ${tracked ? "other " : ""}features are on your sheet.`}
          </Note>
          {back ? <Note tone="info">{back}</Note> : null}
          {note ? <Note tone="info">{note}</Note> : null}
        </>
      ) : null}
      {canRest && kind ? (
        <div style={{ display: "flex", gap: theme.space(2) }}>
          <SmallButton tone="primary" grow onClick={finish}>
            {kind === "short" ? "Finish the Short Rest" : "Finish the Long Rest"}
          </SmallButton>
          <SmallButton onClick={() => setKind(null)}>Cancel</SmallButton>
        </div>
      ) : null}
      {/* On the character's own page a viewer who may add classes holds the slot parts already (D-261127-423). */}
      {character ? <HiddenHere home="rest" holder={"characterId" in props.target ? { ...character, mayAdd: true } : character} /> : null}
    </Section>
  );
}
