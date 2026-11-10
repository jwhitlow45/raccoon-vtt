import { useLayoutEffect, useMemo, type CSSProperties } from "react";
import type { RoomState } from "#shared/model.ts";
import { ABILITY_ABBR, ABILITY_NAMES } from "#shared/rules/skills.ts";
import { Icon } from "../../components/Icon.tsx";
import { spokenProficiency } from "../../components/ProficiencyMark.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import type { You } from "../../state/types.ts";
import { useRoomView } from "../../state/view.ts";
import { useBlockHeader, type BlockHeaderApi } from "../dice/BlockHeader.tsx";
import { blockRoller, type BlockFrom, type BlockRoller } from "../dice/blockRolls.ts";
import { useAbilityMenu } from "../dice/useAbilityMenu.tsx";
import type { AbilityBox } from "./abilityTable.ts";
import { labelsOf } from "../../state/labels.ts";

/**
 * The six abilities three across, as the 2024 block prints them: about a
 * third of the height of a seven-row table (docs/design/design-v1-dice-ui.md 6.1
 * and 6.3). A PC's block and a monster's draw the same grid, so the two
 * read alike in the token panel.
 *
 * An ability whose save is proficient has its whole box outlined, name,
 * score, modifier and save together, and nothing else sets it apart
 * (D-261030-588). The outline is FL-12's border: 1 px in the text's color,
 * never the accent's, drawn inside the box's own rounded edge as a shadow,
 * so no box, row or grid changes size for it.
 *
 * With `roll`, where the viewer may roll for the block's creature, the six
 * boxes open that ability's rolls (docs/design/design-v1-stat-block-rolls.md): a
 * group of six buttons that look as the text boxes do, whose newest result
 * shows in the panel's header line (docs/design/design-v1-token-roll-header.md).
 * Without it the grid is the read only list it always was.
 */
/**
 * Whom a block's boxes roll for, as the viewer reads the room (section 2 of
 * docs/design/design-v1-stat-block-rolls.md), or null where they stay text. The
 * same creature keeps the same object across the room's changes, so a list
 * that is open is not handed a new roller at every op.
 */
/** The roller as text, so equal rollers are equal values and the room store skips the redraw. */
export function blockRollerText(s: { view: RoomState | null; you: You | null; sceneId: string | null }, from: BlockFrom): string {
  return s.view && s.you ? (JSON.stringify(blockRoller(s.view, s.you, s.sceneId, from, labelsOf(s))) ?? "null") : "null";
}

export function useBlockRoller(from: BlockFrom): BlockRoller | null {
  // Decided inside the selector and compared as text, so a roll or log line elsewhere in the room, which changes the view, redraws nothing here.
  const text = useRoomView((s) => blockRollerText(s, from));
  return useMemo(() => JSON.parse(text) as BlockRoller | null, [text]);
}

const GRID: CSSProperties = { margin: 0, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) };

/** A box's look, FL-15's: the same in a text grid and a rolling one, so the grid never changes size for rolling. */
function boxStyle(a: Pick<AbilityBox, "proficient">): CSSProperties {
  return { padding: `${theme.space(1)}px ${theme.space(2)}px`, borderRadius: theme.radius.sm, background: theme.color.surfaceRaised, lineHeight: theme.leading.tight, ...(a.proficient ? { boxShadow: theme.shadow.markInside } : {}) };
}

const ABBR_STYLE: CSSProperties = { fontSize: theme.font.tiny, fontWeight: theme.weight.bold, letterSpacing: theme.caps, textTransform: "uppercase", color: theme.color.textMuted };

export function AbilityGrid(props: { abilities: readonly AbilityBox[]; roll?: BlockRoller | null | undefined }) {
  // Keyed by the creature, so an open list never carries over to another creature's boxes when a panel switches between two.
  if (props.roll) return <RollingGrid key={JSON.stringify(props.roll.creature)} abilities={props.abilities} roller={props.roll} />;
  return (
    <dl data-ability-grid="" style={GRID}>
      {props.abilities.map((a) => (
        <div
          key={a.key}
          {...(a.proficient ? { "data-save-proficient": "" } : {})}
          style={boxStyle(a)}
        >
          <dt style={ABBR_STYLE}>
            <abbr title={ABILITY_NAMES[a.key]} style={{ textDecoration: "none" }}>
              {ABILITY_ABBR[a.key]}
            </abbr>
          </dt>
          <dd style={{ margin: 0, whiteSpace: "nowrap" }}>
            <strong style={{ fontSize: theme.font.input }}>{a.score}</strong> <span style={{ color: theme.color.textMuted }}>{a.mod}</span>
          </dd>
          <dd style={{ margin: 0, fontSize: theme.font.small, whiteSpace: "nowrap" }}>
            <span style={{ color: theme.color.textMuted }}>Save </span>
            {a.save}
            {/* The outline is not read out, so a screen reader hears a proficient save as one here. */}
            {a.proficient ? <span style={VISUALLY_HIDDEN}>, proficient</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The grid while it rolls: a group of buttons, since a button may not stand
 * inside a `<dl>`'s grouping div. Each button is the whole box, its three
 * lines marked spans in the text box's words, and its name is the printed
 * words so a reader hears each box once. Of the six boxes' last outcomes
 * the newest shows in the panel's header line (BlockHeader.tsx), which
 * stays when the grid folds away. Outside a header host a roll still goes,
 * said by the Dice panel's line or the toast, and nothing throws.
 */
function RollingGrid(props: { abilities: readonly AbilityBox[]; roller: BlockRoller }) {
  const header = useBlockHeader();
  const rolls = header?.rolls;
  // While it rolls, the panel is a rolling surface of the throw's store.
  useLayoutEffect(() => rolls?.(), [rolls]);
  return (
    <div data-ability-grid="" role="group" aria-label="Abilities" style={GRID}>
      {props.abilities.map((a) => (
        <RollingBox key={a.key} box={a} roller={props.roller} header={header} />
      ))}
    </div>
  );
}

function RollingBox(props: { box: AbilityBox; roller: BlockRoller; header: BlockHeaderApi | null }) {
  const a = props.box;
  const { header } = props;
  const menu = useAbilityMenu({
    ability: a.key,
    roller: props.roller,
    throwHost: header?.throwHost ?? null,
    onHold: () => header?.hold(),
    onSent: (sent, pick) => header?.sent(sent, pick),
    onUnsent: (words, pick) => header?.unsent(words, pick),
    onPicked: () => header?.picked(),
  });
  const line: CSSProperties = { display: "block" };
  return (
    <>
      <button
        type="button"
        {...menu.buttonProps}
        {...(a.proficient ? { "data-save-proficient": "" } : {})}
        aria-label={`${ABILITY_NAMES[a.key]} ${a.score}, ${a.mod}, save ${a.save}${a.proficient ? spokenProficiency("prof") : ""}`}
        // `font` first: its shorthand resets line-height, which the box look then sets back to FL-15's tight leading.
        style={{ font: "inherit", ...boxStyle(a), display: "block", position: "relative", boxSizing: "border-box", width: "100%", margin: 0, textAlign: "left", color: "inherit", border: 0, cursor: "pointer", ...menu.pressStyle }}
      >
        <span data-ability-abbr="" style={{ ...line, ...ABBR_STYLE }}>
          {ABILITY_ABBR[a.key]}
        </span>
        <span data-ability-score="" style={{ ...line, whiteSpace: "nowrap" }}>
          <strong style={{ fontSize: theme.font.input }}>{a.score}</strong> <span style={{ color: theme.color.textMuted }}>{a.mod}</span>
        </span>
        <span data-ability-save="" style={{ ...line, fontSize: theme.font.small, whiteSpace: "nowrap" }}>
          <span style={{ color: theme.color.textMuted }}>Save </span>
          {a.save}
        </span>
        {/* Says the box opens. Content beside content: it takes no room, and the abbreviation never reaches it. */}
        <span data-ability-mark="" aria-hidden="true" style={{ position: "absolute", top: 6, right: 6, display: "flex", pointerEvents: "none", color: theme.color.textMuted }}>
          <Icon name="chevronDown" size={10} />
        </span>
      </button>
      {menu.menu}
    </>
  );
}
