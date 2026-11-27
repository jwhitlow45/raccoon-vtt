import { useEffect, useRef } from "react";
import type { PartyGroup } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { MAX_PARTY_GROUPS } from "#shared/protocol.ts";
import { MAX_LEVEL, MIN_LEVEL } from "#shared/srd/xp-budget.ts";
import { Button } from "../../components/Button.tsx";
import { Select } from "../../components/Field.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { Stepper } from "../tokens/ui.tsx";
import { partySize, type partyFromCharacters } from "./budget.ts";
import { addGroup, setGroup } from "./draft.ts";

/*
 * The party editor, shared by the Encounters panel's builder and the
 * dungeon generator's Monsters rows (docs/design/design-v1-dungeon-stock.md
 * 1, D-261127-071), so both budget for the same party the same way.
 */

const LEVEL_OPTIONS = Array.from({ length: MAX_LEVEL - MIN_LEVEL + 1 }, (_, i) => ({ value: String(i + MIN_LEVEL), label: `Level ${i + MIN_LEVEL}` }));

/**
 * The party the budget is for. By default the room's player characters by
 * level, followed live, and a character without a level is named rather
 * than guessed at. Editing makes the party the caller's own, an encounter's
 * saved with it, for a fight planned for another table size or a level to
 * come. Edit the party moves focus to the first stepper.
 */
export function PartyEditor(props: { party: PartyGroup[] | null; roomParty: ReturnType<typeof partyFromCharacters>; onChange(next: PartyGroup[] | null): void }) {
  const { party, roomParty } = props;
  const rows = useRef<HTMLDivElement>(null);
  const editing = party !== null;
  const opened = useRef(editing);
  useEffect(() => {
    if (editing && !opened.current) rows.current?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
    opened.current = editing;
  }, [editing]);
  if (party === null) {
    const size = partySize(roomParty.groups);
    return (
      <>
        <Help>The room's characters{size > 0 ? `: ${groupsText(roomParty.groups)}` : ""}.</Help>
        {roomParty.unleveled.length > 0 ? (
          <Notice>
            The budget leaves out {listText(roomParty.unleveled)}, who {roomParty.unleveled.length === 1 ? "has" : "have"} no level yet. Set one on {roomParty.unleveled.length === 1 ? "the" : "each"} character's card, or edit the party here.
          </Notice>
        ) : null}
        {size === 0 && roomParty.unleveled.length === 0 ? <Help>This room has no characters yet. Edit the party to budget for one.</Help> : null}
        <Button size="sm" onClick={() => props.onChange(roomParty.groups.length > 0 ? roomParty.groups : [{ count: Math.max(1, roomParty.unleveled.length), level: 1 }])}>
          Edit the party
        </Button>
      </>
    );
  }
  return (
    <>
      {party.map((g, i) => (
        <div key={i} ref={i === 0 ? rows : undefined} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
          <Stepper label="Characters" value={g.count} step={1} min={1} max={LIMITS.charactersPerRoom} onChange={(count) => props.onChange(setGroup(party, i, { ...g, count }, LIMITS.charactersPerRoom))} />
          <div style={{ flex: "1 1 120px", display: "flex" }}>
            <Select
              aria-label="Their level"
              value={String(g.level)}
              onChange={(e) => props.onChange(setGroup(party, i, { ...g, level: Number(e.target.value) }, LIMITS.charactersPerRoom))}
              style={{ flex: 1, maxWidth: "100%" }}
            >
              {LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="danger" size="sm" aria-label="Remove this level" title="Remove this level" onClick={() => props.onChange(party.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {party.length === 0 ? <Help>No characters: add a level for the budget.</Help> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button size="sm" onClick={() => props.onChange(addGroup(party))} disabled={party.length >= MAX_PARTY_GROUPS}>
          Add a level
        </Button>
        <Button size="sm" onClick={() => props.onChange(null)}>
          Use the room's characters
        </Button>
      </div>
    </>
  );
}

export default PartyEditor;

/** "4 at level 3, 1 at level 4". */
export function groupsText(groups: readonly PartyGroup[]): string {
  return groups.map((g) => `${g.count} at level ${g.level}`).join(", ");
}

/** "Thorn", "Thorn and Vex", "Ash, Thorn and Vex". */
export function listText(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
