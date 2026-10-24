import type { RoomState } from "#shared/model.ts";
import { Switch } from "../../components/Switch.tsx";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { ownsToken } from "../tokens/access.ts";
import type { SelfRef } from "../tokens/durations.ts";
import { Section } from "../tokens/ui.tsx";
import { useSend } from "./hooks.ts";
import { ownsEntry } from "./logic.ts";
import { reactionTarget, type ReactionTarget } from "./ready.ts";

type You = { role: "dm" | "player"; memberId: string } | null | undefined;

/**
 * The Reaction a viewer may mark used for a creature
 * (docs/design-v1-token-sections.md 3.2): the one `reactionTarget` names,
 * its own row's or, for a companion sharing its character's turn, its own.
 * The DM marks any. A player marks a row they own by `ownsEntry`, as the
 * server's `encounter.update` allows, so a player lent a character's token
 * whose row is the character's gets none, and a shared companion's own
 * for its owners, as its sub-row offers it. Null outside the fight and for
 * every other viewer, who read a spent Reaction from the row's tag.
 */
export function reactionFor(view: Pick<RoomState, "tokens" | "characters" | "encounter">, you: You, self: SelfRef): ReactionTarget | null {
  const answer = reactionTarget(view, self);
  if (!answer || !you) return null;
  if (you.role === "dm") return answer;
  if (answer.kind === "companion") {
    const token = view.tokens[answer.tokenId];
    return token && ownsToken(view, you.memberId, token) ? answer : null;
  }
  const entry = view.encounter?.entries.find((e) => e.id === answer.entryId);
  return entry && ownsEntry(view, you.memberId, entry) ? answer : null;
}

/**
 * Combat's Reaction section on the token panel and a character's page: the
 * tracker row's Reaction used switch alone, while the creature has a
 * Reaction in the fight that this viewer may mark. Ready keeps its one
 * editor, Conditions' Readied (D-261024-40).
 */
export function ReactionSection(props: { self: SelfRef; name: string }) {
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const encounter = useRoomView((s) => s.view?.encounter);
  const you = useRoomView((s) => s.you);
  const answer = tokens && characters ? reactionFor({ tokens, characters, encounter: encounter ?? null }, you, props.self) : null;
  if (!answer) return null;
  return (
    <Section title="Reaction">
      {/* Named for its creature, as the uses list is: a companion sharing its character's turn holds a Reaction of its own. */}
      <div role="group" aria-label={`${props.name}'s reaction`}>
        <ReactionSwitch answer={answer} dm={you?.role === "dm"} />
      </div>
    </Section>
  );
}

/**
 * The Reaction used switch, in the tracker row's words wherever it stands:
 * a row's options, a companion's sub-row and the Combat section. The DM's
 * and a companion's own are patches this device predicts. A player's row
 * waits for the server (design 7.4), busy until it answers.
 */
export function ReactionSwitch(props: { answer: ReactionTarget; dm: boolean }) {
  const { answer } = props;
  const actions = useRoomActions();
  const send = useSend();
  const used = useRoomView((s) =>
    answer.kind === "companion" ? s.view?.tokens[answer.tokenId]?.companion?.reactionUsed === true : s.view?.encounter?.entries.find((e) => e.id === answer.entryId)?.reactionUsed === true,
  );
  if (answer.kind === "companion") {
    return (
      <Switch
        label="Reaction used"
        help="Its own, which clears when its character's turn starts"
        checked={used}
        onChange={(on) => actions.dispatch({ t: "token.update", tokenId: answer.tokenId, patch: { companionReaction: on } })}
      />
    );
  }
  if (props.dm) {
    return <Switch label="Reaction used" help="Clears at the start of its turn" checked={used} onChange={(reactionUsed) => actions.dispatch({ t: "encounter.update", entryId: answer.entryId, patch: { reactionUsed } })} />;
  }
  return (
    <Switch
      label="Reaction used"
      help="Clears at the start of your turn"
      checked={used}
      busy={send.waiting}
      onChange={(reactionUsed) => send.send({ t: "encounter.update", entryId: answer.entryId, patch: { reactionUsed } })}
    />
  );
}
