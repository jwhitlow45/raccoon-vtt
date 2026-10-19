import { useState, type Ref } from "react";
import type { RollNumbers } from "#shared/dice/bonus.ts";
import { ABILITY_KEYS, type AbilityKey, type Character } from "#shared/model.ts";
import { pcShape } from "#shared/rules/pcStats.ts";
import { signed } from "#shared/statBlock.ts";
import { Loading } from "../../components/Loading.tsx";
import { Group, Help, Section } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { editsPcStats } from "../tokens/access.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { StatBlockView } from "../monsters/StatBlockView.tsx";
import { pcBlockSummary } from "../tokens/creatureKind.ts";
import { useSrdList } from "../tokens/StatSummary.tsx";
import { saveUnitsOf } from "../tokens/statSummary.ts";
import { Note, SmallButton } from "../tokens/ui.tsx";
import { knownFormPatch, knownFormsIn, missingFormText, rememberedDruidLevel } from "./knownForms.ts";
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
 * view and Edit. A Druid's known forms come first, each a one-tap Wild
 * Shape, in no shape or in Wild Shape (docs/design-v1-known-forms.md 5.3).
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
  // In another shape, such as Polymorph, the forms are not drawn: End the shape first.
  const formCount = edits && pcShape(character) !== "other" ? (character.knownForms?.length ?? 0) : 0;
  const forms = formCount > 0 ? <KnownFormsSection character={character} /> : null;
  // Folded, the row says what the block holds, so it reads without opening (docs/design-v1-look-pass.md 3.3).
  const summary = pcBlockSummary(character, formCount);
  if (!character.stats && !shaped) {
    return (
      <>
        <Group label="Stat block" open={fold.open} onToggle={fold.onToggle} foldRef={fold.foldRef} summary={summary}>
          {forms}
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
      <Group label="Stat block" open={fold.open} onToggle={fold.onToggle} foldRef={fold.foldRef} summary={summary} action={take}>
        {forms}
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

/**
 * A Druid's known forms as one-tap buttons, sorted as in Take a shape. One
 * takes the form as Wild Shape, as there. In Wild Shape the buttons are
 * toggles: the current form is pressed and unavailable, keeping the focus a
 * tap just gave it, and the others change to theirs, which is using Wild
 * Shape again. The reducer keeps the first AC and speeds to put back, and
 * the new form's Temporary HP go only where they are more than held. Out of
 * a shape they are plain buttons, never toggles. Each button's text names
 * it, with no `label`, which would also set a native tooltip.
 */
function KnownFormsSection(props: { character: Character }) {
  const { character } = props;
  const actions = useRoomActions();
  const roomId = useRoomView((s) => s.roomId);
  const { list, failed } = useSrdList(true);
  const known = knownFormsIn(character.knownForms, list ?? []);
  const current = pcShape(character) === "wild" ? character.actor.srdId : undefined;
  return (
    <Section label="Known forms">
      {failed ? (
        <SrdLoadFailed what="The known forms" inline />
      ) : !list ? (
        <Loading text="Loading the known forms…" />
      ) : (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            {known.forms.map((m) => (
              <SmallButton
                key={m.srdId}
                wrap
                pressed={current !== undefined ? m.srdId === current : undefined}
                unavailable={m.srdId === current}
                onClick={() => actions.dispatch({ t: "character.update", characterId: character.id, patch: { actor: knownFormPatch(m, character, rememberedDruidLevel(roomId, character.id)) } })}
              >
                {m.name}
              </SmallButton>
            ))}
          </div>
          {known.missing.map((id) => (
            <Note key={id}>{missingFormText(id)}</Note>
          ))}
        </>
      )}
    </Section>
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
