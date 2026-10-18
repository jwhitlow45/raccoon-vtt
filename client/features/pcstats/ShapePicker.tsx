import { useDeferredValue, useId, useMemo, useState } from "react";
import type { Character } from "#shared/model.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Input, Select } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { UnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { MonsterList, type ListedRow } from "../monsters/MonsterList.tsx";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { SrdCredit, useSrdMonsters } from "../monsters/StatBlockView.tsx";
import { editsPcStats } from "../tokens/access.ts";
import { whose } from "../tokens/companionBlocks.ts";
import { monsterMatcher } from "../tokens/monsterSearch.ts";
import { byCrThenName, DRUID_LEVELS, fitsShapeLimit, shapeLimit } from "./shapeLevel.ts";
import { shapePatch, shapeTempHp, wildShapeDetail, type ShapeKind } from "./shape.ts";

/** Whether an SRD creature is a Beast, which Wild Shape and Polymorph take. */
function isBeast(m: SrdMonster): boolean {
  return /^beast\b/i.test(m.type.trim());
}

/**
 * "Take a shape" (docs/design-v1-pc-stats.md 7.3): the SRD's creatures with
 * the Beasts filtered in, then one step that says what the shape keeps,
 * Wild Shape by default, and Take the shape, one `character.update` on the
 * character's own actor with the creature's AC and speeds and the shape's
 * temporary HP, a checkbox on by default (W7B-P-9). HP stays the
 * character's.
 */
export function ShapePicker(props: { character: Pick<Character, "id" | "name" | "level" | "actor" | "ownerIds" | "stats">; onClose(): void }) {
  const actions = useRoomActions();
  const { monsters, failed } = useSrdMonsters();
  const [query, setQuery] = useState("");
  const [beastsOnly, setBeastsOnly] = useState(true);
  const [druidLevel, setDruidLevel] = useState<number | null>(null);
  const [picked, setPicked] = useState<SrdMonster | null>(null);
  const [kind, setKind] = useState<ShapeKind>("wild");
  const [gainTemp, setGainTemp] = useState(true);
  const deferred = useDeferredValue(query);
  const matches = useMemo(() => monsterMatcher(deferred), [deferred]);
  const limit = useMemo(() => (druidLevel === null ? null : shapeLimit(druidLevel)), [druidLevel]);
  const rows = useMemo(() => {
    const kept = (monsters ?? []).filter((m) => (!beastsOnly || isBeast(m)) && matches(m) && (limit === null || fitsShapeLimit(limit, m)));
    if (limit !== null) kept.sort(byCrThenName);
    return kept.map((m): ListedRow => ({ key: m.srdId, view: m, source: "srd" }));
  }, [monsters, beastsOnly, matches, limit]);
  // Wild Shape forms must be Beasts, so choosing a level turns the filter on. It stays the user's to turn off again.
  const chooseLevel = (value: string) => {
    setDruidLevel(value === "" ? null : Number(value));
    if (value !== "") setBeastsOnly(true);
  };
  const name = props.character.name;
  const you = useRoomView((s) => s.you);

  if (picked) {
    const temp = shapeTempHp(kind, props.character, picked);
    const holding = props.character.actor.hp.temp;
    const take = () => {
      const patch = shapePatch(picked, kind, props.character, gainTemp ? temp : undefined);
      if (actions.dispatch({ t: "character.update", characterId: props.character.id, patch: { actor: patch } }) !== null) props.onClose();
    };
    return (
      <Dialog
        title={`Take the shape of ${picked.name}`}
        onClose={props.onClose}
        back={{ label: "Back to the creatures", onBack: () => setPicked(null) }}
        phone="sheet"
        width="md"
        footer={
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" onClick={take}>
              Take the shape
            </Button>
          </>
        }
      >
        {/* Its step rises from the bottom on a phone, so a shape other than Wild Shape, which only Take the shape sends, holds it against a swipe (docs/design-v1-sheet-swipe.md 4.6). */}
        <UnsavedInput unsaved={kind !== "wild" || !gainTemp} />
        <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
          <ShapeChoice name={name} creature={picked.name} wild={wildShapeDetail(props.character, picked.name, editsPcStats(you, props.character))} value={kind} onChange={setKind} />
          {holding >= temp ? (
            <Help>{`${whose(name)} ${holding} Temporary HP stay, as they are no fewer than the ${temp} the shape gives.`}</Help>
          ) : (
            <Checkbox
              label={`Gain ${temp} Temporary HP (${kind === "wild" ? "Wild Shape" : "Polymorph"})`}
              help={kind === "wild" ? `The Druid level, read as ${whose(name)} level.` : `${whose(picked.name)} HP. What is left of them goes when the shape ends.`}
              checked={gainTemp}
              onChange={setGainTemp}
            />
          )}
          <Help>{`The token takes ${whose(picked.name)} AC and Speeds until the shape ends, then ${whose(name)} own come back. It keeps ${whose(name)} HP, conditions and Passive Perception in either shape.`}</Help>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Take a shape" onClose={props.onClose} phone="fill" width="md">
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
        <Help>{`An SRD creature for ${whose(name)} token to take the shape of. The token keeps ${whose(name)} HP and conditions.`}</Help>
        <Input type="search" aria-label="Search creatures" placeholder="Search: wolf, cr 0-1" value={query} enterKeyHint="search" onChange={(e) => setQuery(e.target.value)} style={{ width: "100%" }} />
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(4), rowGap: theme.space(1) }}>
          <Checkbox label="Beasts only" checked={beastsOnly} onChange={setBeastsOnly} />
          <label style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
            Druid level
            <Select value={druidLevel === null ? "" : String(druidLevel)} onChange={(e) => chooseLevel(e.target.value)}>
              <option value="">Any</option>
              {DRUID_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {limit ? <Help>{limit.label}</Help> : null}
        {failed ? <SrdLoadFailed what="The creature list" /> : null}
        {!monsters && !failed ? <Loading text="Loading the creatures…" /> : null}
        <MonsterList items={rows} onPick={(key) => setPicked(monsters?.find((m) => m.srdId === key) ?? null)} />
        {monsters && rows.length === 0 ? <Help>No creature matches.</Help> : null}
        <SrdCredit />
      </div>
    </Dialog>
  );
}

/** Wild Shape or another shape, as two radios each 44 px tall, whose words say what the shape keeps. */
function ShapeChoice(props: { name: string; creature: string; wild: string; value: ShapeKind; onChange(kind: ShapeKind): void }) {
  const group = useId();
  const options: { value: ShapeKind; label: string; detail: string }[] = [
    { value: "wild", label: "Wild Shape", detail: props.wild },
    { value: "other", label: "Polymorph or another shape", detail: `All of ${props.creature}’s numbers.` },
  ];
  return (
    <div role="radiogroup" aria-label="Which shape" style={{ display: "grid", gap: theme.space(1) }}>
      {options.map((o) => (
        <label key={o.value} style={{ display: "flex", alignItems: "flex-start", gap: theme.space(3), minHeight: theme.touch, padding: `${theme.space(2)}px 0`, cursor: "pointer" }}>
          <input type="radio" name={group} value={o.value} checked={props.value === o.value} onChange={() => props.onChange(o.value)} style={{ width: 22, height: 22, margin: 0, flex: "none", accentColor: theme.color.accent }} />
          <span style={{ display: "grid", gap: theme.space(1) }}>
            <strong>{o.label}</strong>
            <span style={{ color: theme.color.textMuted }}>{o.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
