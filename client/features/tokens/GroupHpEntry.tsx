import { useId, useLayoutEffect, useMemo } from "react";
import type { Token } from "#shared/model.ts";
import type { EntryStatus } from "../../canvas/barButtons.ts";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { useRoomView } from "../../state/view.ts";
import { groupAccess, hpTargets, type HpTarget } from "./groupHp.ts";
import type { HpPlace } from "./hpDraft.ts";
import { HpEntry, type HpRest } from "./HpSection.tsx";
import { Note } from "./ui.tsx";

const NO_CHARACTERS = {};

/** The words for a group none of whose HP this viewer may change. */
const NONE_WORDS = "You cannot change the HP of any of them.";

/** What this viewer may do to each selected creature's HP, and to all of them through one entry (groupHp.ts). */
export function useGroupHp(tokens: readonly Token[]): { targets: HpTarget[]; access: "all" | "relative" | "none" } {
  const you = useRoomView((s) => s.you);
  const characters = useRoomView((s) => s.view?.characters ?? NO_CHARACTERS);
  const playersApplyDamage = useRoomView((s) => s.view?.meta.settings.playersApplyDamage ?? false);
  const targets = useMemo(
    () => hpTargets(tokens, { role: you?.role ?? "player", memberId: you?.memberId, characters, playersApplyDamage }),
    [tokens, you, characters, playersApplyDamage],
  );
  return { targets, access: groupAccess(targets) };
}

/**
 * One damage or healing entry for every selected creature, in the group's
 * action bar and the initiative tracker. It names whoever this viewer may
 * not change, so a player sees why their friend's HP stayed put. A short
 * group window puts the field and Apply first, as the single token's does
 * (`fieldFirst`, docs/design-v1-token-window.md 5.8). On an upright
 * phone's resting strip its notes go to the strip's status line, the
 * first of them while the field is empty, and stay the field's
 * description (docs/design-v1-bar-compact.md 3.3).
 */
export function GroupHpEntry(props: { tokens: readonly Token[]; place: HpPlace; fieldFirst?: boolean; rest?: HpRest }) {
  const { targets, access } = useGroupHp(props.tokens);
  const left = targets.filter((t) => t.access === "none").map((t) => t.name);
  const notes = [
    ...(left.length > 0 ? [`Leaves out ${left.join(", ")}: you cannot change their HP.`] : []),
    ...(access === "relative" && targets.some((t) => t.access === "all") ? ["Damage and healing only, since some of them are not yours."] : []),
  ];
  const notesId = useId();
  const resting = props.rest?.resting === true;
  const onStatus = props.rest?.onStatus;
  // With no entry to say it, the strip's status line still says why there is none.
  const noneSaid = access === "none" ? JSON.stringify({ error: null, dead: null, preview: null, typed: false, crit: false, reach: 0, left, standing: NONE_WORDS } satisfies EntryStatus) : null;
  useLayoutEffect(() => {
    if (noneSaid !== null && onStatus) onStatus(JSON.parse(noneSaid) as EntryStatus);
  }, [noneSaid, onStatus]);
  if (access === "none") return resting ? null : <Note>{NONE_WORDS}</Note>;
  return (
    <>
      <HpEntry
        targets={targets}
        access={access}
        place={props.place}
        fieldFirst={props.fieldFirst}
        rest={props.rest}
        standing={notes[0] ?? null}
        describedBy={resting && notes.length > 0 ? notesId : undefined}
      />
      {resting ? (
        <div id={notesId} style={VISUALLY_HIDDEN}>
          {notes.join(" ")}
        </div>
      ) : (
        notes.map((note) => <Note key={note}>{note}</Note>)
      )}
    </>
  );
}
