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
import { pcBlockSummary } from "../tokens/creatureKind.ts";
import { useSrdList } from "../tokens/StatSummary.tsx";
import { saveUnitsOf } from "../tokens/statSummary.ts";
import { Note, SmallButton } from "../tokens/ui.tsx";
import { useOpenPcStats, useOpenResync } from "./open.ts";
import { lastSyncedLine, resyncNumber } from "./resync.ts";
import { ddbCharacterId } from "#shared/ddb/link.ts";
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
 * view and Edit. Edit has "Re-sync from D&D Beyond" beside it, in a shape
 * too, for a character synced from D&D Beyond or linked to it, and when it
 * last synced under them (docs/design-v1-resync.md 1.1). A Druid's known
 * forms live in the Take a shape picker, which the button opens in no shape
 * or in Wild Shape (docs/design-v1-known-forms.md 5.3, D-261024-29).
 */
export function PcStatBlock(props: {
  character: Character;
  fold: { open: boolean; onToggle(): void; foldRef?: Ref<HTMLButtonElement> };
}) {
  const { character, fold } = props;
  const openStats = useOpenPcStats();
  const openSync = useOpenResync();
  const you = useRoomView((s) => s.you);
  // A token's owner who does not own its character gets no section at all (statBlockShown), and never the buttons that change it.
  const edits = editsPcStats(you, character);
  const [picking, setPicking] = useState(false);
  const shaped = pcShape(character) !== "none";
  // In another shape, such as Polymorph, the button is hidden: End the shape first. In Wild Shape it stays, as the way to change form or forms.
  const formCount = edits && pcShape(character) !== "other" ? (character.knownForms?.length ?? 0) : 0;
  // The count lives on the button, not in the folded summary, which would crowd the row (D-261024-26, D-261024-27). The name stays an action.
  const take = !edits || pcShape(character) === "other" ? null : (
    <SmallButton wrap label={formCount > 0 ? `Take a shape, ${formCount} known ${formCount === 1 ? "form" : "forms"}` : undefined} onClick={() => setPicking(true)}>
      {formCount > 0 ? `${formCount} ${formCount === 1 ? "shape" : "shapes"}` : "Take a shape"}
    </SmallButton>
  );
  const add = () =>
    edits ? (
      <SmallButton wrap onClick={() => openStats(character.id)}>
        Add a stat block
      </SmallButton>
    ) : null;
  const picker = (
    <>
      {picking ? <ShapePicker character={character} onClose={() => setPicking(false)} /> : null}
    </>
  );
  // Folded, the row says what the block holds, so it reads without opening (docs/design-v1-look-pass.md 3.3).
  const summary = pcBlockSummary(character);
  if (!character.stats && !shaped) {
    return (
      <>
        <Group label="Stat block" open={fold.open} onToggle={fold.onToggle} foldRef={fold.foldRef} summary={summary}>
            {edits ? (
            <>
              <Help>Add this character's stat block, or take a shape such as Wild Shape.</Help>
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
      <Group label="Stat block" open={fold.open} onToggle={fold.onToggle} foldRef={fold.foldRef} summary={summary} action={take}>
        {shaped ? <ShapeBody character={character} edits={edits} /> : <PcStatsView character={character} />}
        {edits ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            {character.stats ? <SmallButton onClick={() => openStats(character.id)}>Edit</SmallButton> : add()}
            {/* Re-sync needs a block and a D&D Beyond number to fetch, the sheet link's or the last sync's (docs/design-v1-resync.md 1.1). */}
            {character.stats && resyncNumber(character, ddbCharacterId) ? (
              <SmallButton wrap onClick={() => openSync(character.id)}>
                Re-sync from D&amp;D Beyond
              </SmallButton>
            ) : null}
          </div>
        ) : null}
        {edits && character.stats && character.ddbSync ? <Help>{lastSyncedLine(character.ddbSync.at)}</Help> : null}
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
        <SrdLoadFailed what="The creature's stat block" inline />
        {end}
      </>
    );
  }
  if (!list) return <Loading text="Loading the creature's stat block…" />;
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
