import { useState, type Ref } from "react";
import type { RollNumbers } from "#shared/dice/bonus.ts";
import { ABILITY_KEYS, type AbilityKey, type Character } from "#shared/model.ts";
import { pcShape } from "#shared/rules/pcStats.ts";
import { signed } from "#shared/statBlock.ts";
import { Loading } from "../../components/Loading.tsx";
import { Group, Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { editsPcStats } from "../tokens/access.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { StatBlockView } from "../monsters/StatBlockView.tsx";
import { useSrdList } from "../tokens/StatSummary.tsx";
import { saveUnitsOf } from "../tokens/statSummary.ts";
import { Note, SmallButton } from "../tokens/ui.tsx";
import { useOpenPcStats } from "./open.ts";
import { PcStatsView } from "./PcStatsView.tsx";
import { END_SHAPE, shapeNote } from "./shape.ts";
import { useCharacterRollNumbers } from "./useRollNumbers.ts";
import { ShapePicker } from "./ShapePicker.tsx";

/**
 * A player character's "Stat block" section (docs/design-v1-pc-stats.md
 * 7.1 and 7.3), for the DM and the character's players, in its token's
 * panel under the image and on its card. It is always the fold "Stat block",
 * on the panel's one remembered state. Without a block or a shape the fold
 * reads "None yet" and opens on a line of help with "Add a stat block" and
 * "Take a shape". With a block or a shape, "Take a shape" sits on the fold's
 * row. A shape shows what it does, the numbers the character rolls with in
 * it, the creature's block and "End the shape". Without one, the block's
 * view and Edit.
 */
export function PcStatBlock(props: {
  character: Character;
  fold: { open: boolean; onToggle(): void; foldRef?: Ref<HTMLButtonElement> };
}) {
  const { character, fold } = props;
  const openStats = useOpenPcStats();
  const you = useRoomView((s) => s.you);
  // A token's owner who does not own its character gets no section at all (statBlockShown), and never the buttons that change it.
  const edits = editsPcStats(you, character);
  const [picking, setPicking] = useState(false);
  const shaped = pcShape(character) !== "none";
  const take = shaped || !edits ? null : (
    <SmallButton wrap onClick={() => setPicking(true)}>
      Take a shape
    </SmallButton>
  );
  const add = () =>
    edits ? (
      <SmallButton wrap onClick={() => openStats(character.id)}>
        Add a stat block
      </SmallButton>
    ) : null;
  const picker = picking ? <ShapePicker character={character} onClose={() => setPicking(false)} /> : null;
  if (!character.stats && !shaped) {
    return (
      <>
        <Group label="Stat block" open={fold.open} onToggle={fold.onToggle} foldRef={fold.foldRef} summary="None yet">
          {edits ? (
            <>
              <Help>Add this character’s stat block, or take a shape such as Wild Shape.</Help>
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
                {add()}
                {take}
              </div>
            </>
          ) : null}
        </Group>
        {picker}
      </>
    );
  }
  return (
    <>
      <Group label="Stat block" open={fold.open} onToggle={fold.onToggle} foldRef={fold.foldRef} action={take}>
        {shaped ? <ShapeBody character={character} edits={edits} /> : <PcStatsView character={character} />}
        {edits ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            {character.stats ? <SmallButton onClick={() => openStats(character.id)}>Edit</SmallButton> : add()}
          </div>
        ) : null}
      </Group>
      {picker}
    </>
  );
}

/** A shape's part of the section: what it does, the numbers rolled with, the creature's block and "End the shape". */
function ShapeBody(props: { character: Character; edits: boolean }) {
  const { character } = props;
  const actions = useRoomActions();
  const srdId = character.actor.srdId!;
  const { list, failed } = useSrdList(true);
  const monster = list?.find((m) => m.srdId === srdId);
  // The numbers its rolls get, read from the SRD table as the server reads them.
  const { numbers } = useCharacterRollNumbers(character.id);
  const end = props.edits ? (
    <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
      <SmallButton onClick={() => actions.dispatch({ t: "character.update", characterId: character.id, patch: { actor: END_SHAPE } })}>End the shape</SmallButton>
    </div>
  ) : null;
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
      <Note tone="info">{shapeNote(character, monster?.name ?? srdId, props.edits)}</Note>
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
