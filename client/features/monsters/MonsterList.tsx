import type { CustomMonster } from "#shared/model.ts";
import type { SrdMonster, StatBlockMonster } from "#shared/srd/monsters.ts";
import { Row } from "../../components/Row.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";

/**
 * The list a monster browser shows: the room's own monsters, marked, a
 * character's companion stat blocks, marked with whose they are, and the
 * SRD's, each a card row with its size, type and CR. The Monsters panel and
 * the stat block picker on a token share it.
 */

export const SIZE_WORD: Record<SrdMonster["size"], string> = {
  tiny: "Tiny",
  small: "Small",
  medium: "Medium",
  large: "Large",
  huge: "Huge",
  gargantuan: "Gargantuan",
};

export type Listed = { key: string; view: StatBlockMonster } & ({ source: "room"; monster: CustomMonster } | { source: "srd"; srd: SrdMonster });

/**
 * A row of any list: a room monster, an SRD monster, or a character's
 * companion stat block, which `tag` marks with whose it is, such as "Bree's"
 * (docs/design-v1-companion-stat-blocks.md 6.1).
 */
export type ListedRow = { key: string; view: StatBlockMonster; source: "room" | "srd" | "block"; tag?: string };

/**
 * Card rows, a gap apart, as every list of rows that are buttons is
 * (components/Row.tsx). With `subpages`, a pick opens the monster as the
 * panel's subpage, and each row carries its key as an opener id
 * ("monster-room:" and the room monster's id, or "monster-srd:" and the
 * SRD id), so Back finds it after an edit renames or moves it and tells
 * apart two monsters of one name (features/panels.ts useSubpageFocus).
 */
export function MonsterList(props: { items: readonly ListedRow[]; onPick(key: string): void; subpages?: boolean }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(1) }}>
      {props.items.map((m) => (
        <li key={m.key}>
          <Row
            onClick={() => props.onPick(m.key)}
            opener={props.subpages ? `monster-${m.key}` : undefined}
            title={m.view.name}
            detail={`${SIZE_WORD[m.view.size]} ${m.view.type}`}
            trailing={
              <>
                {m.source === "room" ? <RoomBadge /> : m.tag ? <Tag tone="muted">{m.tag}</Tag> : null}
                <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, whiteSpace: "nowrap" }}>CR {m.view.cr}</span>
              </>
            }
          />
        </li>
      ))}
    </ul>
  );
}

/** Marks the room's own monster among the SRD's: a status, so a muted Tag rather than the accent, which means "act here". */
export function RoomBadge() {
  return <Tag tone="muted">This room</Tag>;
}
