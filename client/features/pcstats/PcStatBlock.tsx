import { useState, type ReactNode, type Ref } from "react";
import type { RollNumbers } from "#shared/dice/bonus.ts";
import { ABILITY_KEYS, type AbilityKey, type Character } from "#shared/model.ts";
import { pcShape } from "#shared/rules/pcStats.ts";
import { signed } from "#shared/statBlock.ts";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { StatBlockView } from "../monsters/StatBlockView.tsx";
import { useSrdList } from "../tokens/StatSummary.tsx";
import { srdBlock, saveUnitsOf } from "../tokens/statSummary.ts";
import { Note, Section, SmallButton } from "../tokens/ui.tsx";
import { useOpenPcStats } from "./open.ts";
import { PcStatsView } from "./PcStatsView.tsx";
import { END_SHAPE, shapedRollNumbers, shapeNote } from "./shape.ts";
import { ShapePicker } from "./ShapePicker.tsx";

/**
 * A player character's "Stat block" section (docs/design-v1-pc-stats.md
 * 7.1 and 7.3), for the DM and the character's players, in its token's
 * panel under the image and on its card. Without a block or a shape it
 * holds the summary line, with "Add a stat block" and "Take a shape" on
 * the heading's row. With either it is the disclosure "Stat block", "Take
 * a shape" still on its row and the summary under it, folded or open. A
 * shape shows what it does, the numbers the character rolls with in it,
 * the creature's block and "End the shape". Without one, the block's view
 * and Edit.
 */
export function PcStatBlock(props: {
  character: Character;
  fold: { open: boolean; onToggle(): void; foldRef?: Ref<HTMLButtonElement> };
  /** The token's summary line, under the heading whether the block is open or folded. */
  summary?: ReactNode;
}) {
  const { character, fold } = props;
  const openStats = useOpenPcStats();
  const [picking, setPicking] = useState(false);
  const shaped = pcShape(character) !== "none";
  const take = shaped ? null : (
    <SmallButton wrap onClick={() => setPicking(true)}>
      Take a shape
    </SmallButton>
  );
  const add = (ref?: Ref<HTMLButtonElement>) => (
    <SmallButton ref={ref} wrap onClick={() => openStats(character.id)}>
      Add a stat block
    </SmallButton>
  );
  const picker = picking ? <ShapePicker character={character} onClose={() => setPicking(false)} /> : null;
  if (!character.stats && !shaped) {
    return (
      <>
        <Section
          title="Stat block"
          aside={
            <span style={{ display: "inline-flex", flexWrap: "wrap", justifyContent: "flex-end", gap: theme.space(2) }}>
              {add(fold.foldRef)}
              {take}
            </span>
          }
        >
          {props.summary}
        </Section>
        {picker}
      </>
    );
  }
  const summary =
    take || props.summary ? (
      <>
        {take}
        {props.summary ? <div style={{ flexBasis: "100%", minWidth: 0, paddingBottom: theme.space(1) }}>{props.summary}</div> : null}
      </>
    ) : undefined;
  return (
    <>
      <Section title="Stat block" fold={{ ...fold, summary }}>
        {shaped ? <ShapeBody character={character} /> : <PcStatsView character={character} />}
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          {character.stats ? <SmallButton onClick={() => openStats(character.id)}>Edit</SmallButton> : add()}
        </div>
      </Section>
      {picker}
    </>
  );
}

/** A shape's part of the section: what it does, the numbers rolled with, the creature's block and "End the shape". */
function ShapeBody(props: { character: Character }) {
  const { character } = props;
  const actions = useRoomActions();
  const srdId = character.actor.srdId!;
  const { list, failed } = useSrdList(true);
  const monster = list?.find((m) => m.srdId === srdId);
  const block = monster ? srdBlock(monster) : null;
  const numbers = block ? shapedRollNumbers(character, block) : null;
  const end = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
      <SmallButton onClick={() => actions.dispatch({ t: "character.update", characterId: character.id, patch: { actor: END_SHAPE } })}>End the shape</SmallButton>
    </div>
  );
  if (failed) {
    return (
      <>
        <SrdLoadFailed what="The creature’s stat block" inline />
        {end}
      </>
    );
  }
  if (!list) return <Loading text="Loading the creature’s stat block…" />;
  return (
    <>
      <Note tone="info">{shapeNote(character, monster?.name ?? srdId)}</Note>
      {numbers ? (
        <p data-shape-numbers="" style={{ margin: 0, fontSize: theme.font.body14 }}>
          <span style={{ color: theme.color.textMuted }}>Rolls now: saves </span>
          {saveUnitsOf(savesOf(numbers)).join(", ")}
          <span style={{ color: theme.color.textMuted }}>, Perception </span>
          {signed(numbers.skills.perception ?? numbers.abilities.wis.mod)}
        </p>
      ) : null}
      {end}
      {monster ? <StatBlockView view={monster} source="srd" credit /> : <Note>This character takes the shape of an SRD creature this app does not have.</Note>}
    </>
  );
}

function savesOf(numbers: RollNumbers): Record<AbilityKey, number> {
  const saves = {} as Record<AbilityKey, number>;
  for (const a of ABILITY_KEYS) saves[a] = numbers.abilities[a].save;
  return saves;
}
