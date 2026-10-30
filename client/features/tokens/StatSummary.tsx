import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ABILITY_KEYS, type AbilityKey, type Actor, type Character, type Token } from "#shared/model.ts";
import { blockRollNumbers, pcRollNumbers, type RollNumbers } from "#shared/dice/bonus.ts";
import { proficiencyFor, type Proficiency, type ProficiencySource } from "#shared/rules/proficiency.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/Loading.tsx";
import { ProficiencyLabel, ProficiencyUnit } from "../../components/ProficiencyMark.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { statBlockShown, tokenStatBlock } from "../monsters/statBlockLink.ts";
import type { TokenAccess } from "./access.ts";
import { OVER_REACH, SheetLink } from "./SheetLink.tsx";
import { defenseLines, linkedBlockState, moreStatsShown, quickUnit, saveUnits, saveUnitsOf, type LinkedBlock, type VitalItem, type VitalUnit } from "./statSummary.ts";
import { QuickNumberUnit, SpeedThenPerception } from "./QuickNumbers.tsx";
import { pcDefenseLines } from "../pcstats/reading.ts";
import { useCharacterRollNumbers } from "../pcstats/useRollNumbers.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { useSrdBlocks } from "../monsters/srdBlocks.ts";

/*
 * The stat summary (docs/design-v1-token-panel.md 3.2): the vitals line,
 * the saves and the defense lines, and on a short bar the "More stats"
 * disclosure that holds what leaves the line. The token bar places each
 * part in its own order, and the token panel shows the vitals in its stat
 * block's header. The rules are in statSummary.ts.
 */

/** The SRD's blocks while `active`: loaded on first need and kept for the page. A failure stays until a reload (monsters/SrdLoadFailed.tsx). */
export function useSrdList(active: boolean): { list: readonly SrdMonster[] | null; failed: boolean } {
  // Once any view has loaded the SRD chunk this page, a later bar shows its saves without a wait.
  return useSrdBlocks(active);
}

/**
 * The block behind a token's link, where this viewer reads it
 * (statBlockLink.ts statBlockShown): none, loading, failed, or ready. A
 * companion's stored block reads at once from the view, so only an SRD
 * block loads the chunk. The vitals never wait for it.
 */
export function useLinkedBlock(
  token: Pick<Token, "kind" | "companion">,
  actor: Partial<Actor> | undefined,
  access: Pick<TokenAccess, "dm" | "owner">,
  /** The character a player character's token is of, whose own stat block gives its saves and defenses. */
  character?: Character,
): LinkedBlock {
  const monsters = useRoomView((s) => s.view?.monsters);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  const shown = statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor, companion: token.companion !== undefined, character: character !== undefined });
  const pc = shown && character ? pcSummary(character) : null;
  const srd = useSrdList(shown && pc === null && tokenStatBlock(actor, monsters, blocks).kind === "srd");
  // Wild Shape with a stat block rolls with the druid's and the beast's numbers mixed, as the server works them out (docs/design-v1-pc-stats.md 3.6).
  const wild = shown && character?.stats !== undefined && character.actor.wildShape === true;
  const shaped = useCharacterRollNumbers(wild && character ? character.id : null);
  if (pc) return pc;
  const block = shown ? linkedBlockState(actor, monsters, srd, blocks) : ({ kind: "none" } as const);
  if (wild && block.kind === "ready") {
    if (shaped.failed) return { kind: "failed" };
    if (!shaped.numbers) return { kind: "loading" };
    // Wild Shape keeps the druid's own proficiencies beside the beast's (D-261029-419).
    const proficiency = saveProficiencies({ ...(character?.stats ? { stats: character.stats } : {}), monster: { numbers: blockRollNumbers(block.block), cr: block.block.cr }, wildShape: true });
    return { kind: "numbers", saves: savesOf(shaped.numbers), proficiency, defenses: defenseLines(block.block) };
  }
  return block;
}

function savesOf(numbers: RollNumbers): Record<AbilityKey, number> {
  const saves = {} as Record<AbilityKey, number>;
  for (const key of ABILITY_KEYS) saves[key] = numbers.abilities[key].save;
  return saves;
}

function saveProficiencies(source: ProficiencySource): Record<AbilityKey, Proficiency> {
  const out = {} as Record<AbilityKey, Proficiency>;
  for (const key of ABILITY_KEYS) out[key] = proficiencyFor({ kind: "save", ability: key }, source);
  return out;
}

/** A player character's saves and defense lines from its own stat block, or null without one (docs/design-v1-pc-stats.md 7.4). */
function pcSummary(character: Character): LinkedBlock | null {
  const numbers = pcRollNumbers(character);
  if (!numbers || !character.stats || character.actor.srdId !== undefined) return null;
  return { kind: "numbers", saves: savesOf(numbers), proficiency: saveProficiencies({ stats: character.stats }), defenses: pcDefenseLines(character) };
}

function Unit(props: { unit: VitalUnit }) {
  const { unit } = props;
  switch (unit.kind) {
    case "ac":
      return <AcBadge ac={unit.ac} />;
    case "tag":
      return <Tag tone={unit.tone}>{unit.text}</Tag>;
    case "sheet":
      return <SheetLink url={unit.url} />;
    case "text":
      return (
        <span style={{ minWidth: 0 }}>
          {unit.label ? <span style={{ color: theme.color.textMuted }}>{unit.label} </span> : null}
          <span
            style={{
              fontWeight: unit.tone === "muted" ? undefined : theme.weight.strong,
              color: unit.tone === "temp" ? theme.color.ally : unit.tone === "muted" ? theme.color.textMuted : theme.color.text,
            }}
          >
            {unit.value}
          </span>
          {unit.comma ? "," : null}
        </span>
      );
  }
}

/**
 * One line of items at 14 px that wraps between units, never inside one
 * (statSummary.ts VitalUnit), so nothing runs out of even the narrowest
 * box. Each unit is a flex item at its own width: a line breaks before a
 * unit that does not fit, and only a unit wider than the whole box, which
 * none is in the boxes the panel and the bar take, shrinks and wraps
 * inside rather than run out of it. Items stand a little further apart
 * than the units inside them. Speed and Passive Perception are the token
 * panel's quick numbers (QuickNumbers.tsx), the footprints with "30 ft"
 * and "PP 9", so a creature's numbers read alike in both places. HP keeps
 * its words, since it leads the HP entry under it. `afterTag` follows the
 * life tag, where the DM's Revive goes, and `end` the last item, where a
 * narrow token window's elevation badge goes.
 *
 * So no unit stands alone on a line, AC and HP make one part of the line
 * and everything after them another: Speed, Passive Perception, the sheet
 * link and the elevation badge (D-261024-42, FU30-OPUS-3). A speed of
 * several modes keeps its last with Passive Perception
 * (QuickNumbers.tsx SpeedThenPerception). Each part
 * wraps as a whole, so where the line does not hold them all, the second
 * stands together on a line of its own. A part wraps inside itself only
 * where it alone is wider than the box. The second part takes every item
 * that is not AC or HP, so an item of a new kind still shows.
 */
export function VitalsLine(props: { items: readonly VitalItem[]; afterTag?: ReactNode; end?: ReactNode }) {
  if (props.items.length === 0 && props.end == null) return null;
  const indexed = props.items.map((item, i) => ({ item, i }));
  const numbers = indexed.filter(({ item }) => item.key === "ac" || item.key === "hp");
  const rest = indexed.filter(({ item }) => item.key !== "ac" && item.key !== "hp");
  const lastQuick = rest.at(-1)?.i;
  /*
   * The second part takes the panel header's rule (QuickNumbers.tsx): the
   * speed's 4 px between its modes is its line's gap, which its last mode
   * keeps from the rest (SpeedThenPerception), and an item another follows
   * adds 8, so items stand 12 px apart there as in the header.
   */
  const betweenAfter = (i: number) => {
    if (i === lastQuick) return props.end != null ? QUICK_BETWEEN : undefined;
    if (rest.some((r) => r.i === i)) return QUICK_BETWEEN;
    return i < props.items.length - 1 ? { marginInlineEnd: theme.space(1.5) } : undefined;
  };
  const drawn = (item: VitalItem, i: number): ReactNode[] => {
    const between = betweenAfter(i);
    const quick = quickUnit(item);
    if (quick) return [<QuickNumberUnit key={item.key} unit={quick} style={between} />];
    return item.units.flatMap((unit, j) => {
      const gap = j === item.units.length - 1 ? between : undefined;
      const shown = (
        <span key={`${item.key}:${j}`} data-unit={item.key} style={{ display: "inline-flex", alignItems: "center", minWidth: 0, maxWidth: "100%", ...(unit.kind === "sheet" ? null : OVER_REACH), ...gap }}>
          <Unit unit={unit} />
        </span>
      );
      return unit.kind === "tag" && props.afterTag ? [shown, <span key={`${item.key}:after`} style={{ display: "inline-flex", ...OVER_REACH }}>{props.afterTag}</span>] : [shown];
    });
  };
  const quick: ReactNode[] = [];
  for (let n = 0; n < rest.length; n++) {
    const { item, i } = rest[n]!;
    const speed = quickUnit(item);
    const next = rest[n + 1];
    const pp = next ? quickUnit(next.item) : null;
    if (next && speed?.key === "speed" && speed.modes.length > 1 && pp?.key === "passivePerception") {
      quick.push(<SpeedThenPerception key="speed" speed={speed} pp={pp} style={betweenAfter(next.i)} />);
      n++;
    } else quick.push(...drawn(item, i));
  }
  if (props.end != null) {
    quick.push(
      <span key="elevation" data-unit="elevation" style={{ display: "inline-flex", flex: "none", ...OVER_REACH }}>
        {props.end}
      </span>,
    );
  }
  const part = (name: "numbers" | "quick", units: ReactNode[]) =>
    units.length > 0 ? (
      <span key={name} data-vitals-part={name} style={name === "quick" ? QUICK_PART : VITALS_PART}>
        {units}
      </span>
    ) : null;
  return (
    <div data-vitals="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: theme.space(1), columnGap: theme.space(1.5), fontSize: theme.font.body14, minWidth: 0, fontVariantNumeric: "tabular-nums" }}>
      {part("numbers", numbers.flatMap(({ item, i }) => drawn(item, i)))}
      {part("quick", quick)}
    </div>
  );
}

/** A part of a summary line that wraps as a whole, and inside itself only where it alone is wider than the box. */
const LINE_PART = { display: "inline-flex", flexWrap: "wrap", rowGap: theme.space(1), columnGap: theme.space(1.5), minWidth: 0, maxWidth: "100%" } as const;
const VITALS_PART = { ...LINE_PART, alignItems: "center" } as const;
const QUICK_PART = { ...VITALS_PART, columnGap: theme.space(1) } as const;
const QUICK_BETWEEN = { marginInlineEnd: theme.space(2) } as const;
const SAVES_PART = { ...LINE_PART, alignItems: "baseline" } as const;

/**
 * The six saves, "Saves" then "STR +5" and the rest, each a unit that
 * never breaks. The abbreviation takes the ability grid's small capitals
 * (AbilityGrid.tsx): at the body's size, capitals widen the line past one
 * row on a phone held upright, where "Str" fit. Where one line does not
 * hold them, they wrap three and three, "Saves" with the first three, so
 * no save stands alone (D-261024-42). While the SRD chunk loads the line
 * keeps its place and, after the usual 200 ms, says so, and a failed load
 * offers the reload.
 */
export function SavesLine(props: { block: LinkedBlock }) {
  const { block } = props;
  if (block.kind === "none") return null;
  if (block.kind === "loading") {
    return (
      <div style={{ minHeight: 21 }}>
        <Loading text="Loading saves…" />
      </div>
    );
  }
  if (block.kind === "failed") {
    return <SrdLoadFailed what="Saves" inline />;
  }
  // A monster's listed saves, or a character's own flags, mark each ability where its save is proficient.
  const proficiency = block.kind === "numbers" ? block.proficiency : saveProficiencies({ monster: { numbers: blockRollNumbers(block.block), cr: block.block.cr } });
  const saves = (block.kind === "numbers" ? saveUnitsOf(block.saves) : saveUnits(block.block)).map((text, i) => {
    const [ability, value] = text.split(" ");
    const level = proficiency?.[ABILITY_KEYS[i]!] ?? "none";
    const unit = (
      <>
        <span style={{ color: theme.color.textMuted, fontSize: theme.font.tiny, fontWeight: theme.weight.bold, letterSpacing: theme.caps }}>
          <ProficiencyLabel level={level} bare>{ability}</ProficiencyLabel>{" "}
        </span>
        <span style={{ fontWeight: theme.weight.strong }}>{value}</span>
      </>
    );
    // A proficient save is framed whole, "DEX +5", which takes no room from the line (D-261030-527).
    return (
      <span key={ability} style={{ whiteSpace: "nowrap" }}>
        {level === "none" ? unit : <ProficiencyUnit level={level}>{unit}</ProficiencyUnit>}
      </span>
    );
  });
  return (
    <div data-saves="" style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", rowGap: theme.space(1), columnGap: theme.space(1.5), fontSize: theme.font.body14 }}>
      <span data-saves-part="" style={SAVES_PART}>
        <span style={{ color: theme.color.textMuted }}>Saves</span>
        {saves.slice(0, 3)}
      </span>
      <span data-saves-part="" style={SAVES_PART}>
        {saves.slice(3)}
      </span>
    </div>
  );
}

/**
 * The block's vulnerabilities, resistances and immunities, one line each.
 * Running text that wraps between words, and inside one only when it is
 * wider than the box. `clamp` keeps each to three lines in the bar, since a
 * room monster may type 500 characters, and the block holds the rest.
 */
export function DefenseLines(props: { block: LinkedBlock; clamp?: boolean }) {
  if (props.block.kind !== "ready" && props.block.kind !== "numbers") return null;
  const lines = props.block.kind === "numbers" ? props.block.defenses : defenseLines(props.block.block);
  if (lines.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
      {lines.map((line) => (
        <p
          key={line.label}
          data-defense={line.label}
          style={{
            margin: 0,
            overflowWrap: "anywhere",
            ...(props.clamp ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 3, overflow: "hidden" } : null),
          }}
        >
          <span style={{ color: theme.color.textMuted }}>{line.label} </span>
          {line.text}
        </p>
      ))}
    </div>
  );
}

/**
 * A short bar's "More stats" (3.3): speed, Passive Perception, saves and
 * defenses behind one 44 px disclosure after the effects, closed when the
 * bar opens and not remembered. Its name says more than saves because it
 * holds the speed too. Nothing when it would hold nothing.
 */
export function MoreStats(props: { more: readonly VitalItem[]; block: LinkedBlock }) {
  const [open, setOpen] = useState(false);
  // Opened in a window that scrolls, what it shows scrolls itself into view (docs/design-v1-token-window.md 5.7).
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  if (!moreStatsShown(props.more, props.block)) return null;
  return (
    <div ref={ref} style={{ display: "grid", gap: theme.space(2) }}>
      <Button size="sm" expanded={open} onClick={() => setOpen((o) => !o)} style={{ justifyContent: "space-between", width: "100%" }}>
        More stats
        <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />
      </Button>
      {open ? (
        <>
          <VitalsLine items={props.more} />
          <SavesLine block={props.block} />
          <DefenseLines block={props.block} clamp />
        </>
      ) : null}
    </div>
  );
}
