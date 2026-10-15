import { useMemo } from "react";
import type { Token } from "#shared/model.ts";
import { useRoomView } from "../../state/view.ts";
import { groupAccess, hpTargets } from "./groupHp.ts";
import type { HpPlace } from "./hpDraft.ts";
import { HpEntry } from "./HpSection.tsx";
import { Note } from "./ui.tsx";

const NO_CHARACTERS = {};

/**
 * One damage or healing entry for every selected creature, in the group's
 * action bar and the initiative tracker. It names whoever this viewer may
 * not change, so a player sees why their friend's HP stayed put.
 */
export function GroupHpEntry(props: { tokens: readonly Token[]; place: HpPlace }) {
  const you = useRoomView((s) => s.you);
  const characters = useRoomView((s) => s.view?.characters ?? NO_CHARACTERS);
  const playersApplyDamage = useRoomView((s) => s.view?.meta.settings.playersApplyDamage ?? false);
  const targets = useMemo(
    () => hpTargets(props.tokens, { role: you?.role ?? "player", memberId: you?.memberId, characters, playersApplyDamage }),
    [props.tokens, you, characters, playersApplyDamage],
  );
  const access = groupAccess(targets);
  const left = targets.filter((t) => t.access === "none").map((t) => t.name);
  if (access === "none") return <Note>You cannot change the HP of any of them.</Note>;
  return (
    <>
      <HpEntry targets={targets} access={access} place={props.place} />
      {left.length > 0 ? <Note>Leaves out {left.join(", ")}: you cannot change their HP.</Note> : null}
      {access === "relative" && targets.some((t) => t.access === "all") ? <Note>Damage and healing only, since some of them are not yours.</Note> : null}
    </>
  );
}
