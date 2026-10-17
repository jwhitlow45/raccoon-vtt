import { useDeferredValue, useId, useMemo, useState } from "react";
import type { Character } from "#shared/model.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Input } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help } from "../../components/Panel.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { MonsterList, type ListedRow } from "../monsters/MonsterList.tsx";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { SrdCredit, useSrdMonsters } from "../monsters/StatBlockView.tsx";
import { whose } from "../tokens/companionBlocks.ts";
import { monsterMatcher } from "../tokens/monsterSearch.ts";
import { shapePatch, type ShapeKind } from "./shape.ts";

/** Whether an SRD creature is a Beast, which Wild Shape and Polymorph take. */
function isBeast(m: SrdMonster): boolean {
  return /^beast\b/i.test(m.type.trim());
}

/**
 * "Take a shape" (docs/design-v1-pc-stats.md 7.3): the SRD's creatures with
 * the Beasts filtered in, then one step that says what the shape keeps,
 * Wild Shape by default, and Take the shape, one `character.update` on the
 * character's own actor. HP stays the character's.
 */
export function ShapePicker(props: { character: Pick<Character, "id" | "name">; onClose(): void }) {
  const actions = useRoomActions();
  const { monsters, failed } = useSrdMonsters();
  const [query, setQuery] = useState("");
  const [beastsOnly, setBeastsOnly] = useState(true);
  const [picked, setPicked] = useState<SrdMonster | null>(null);
  const [kind, setKind] = useState<ShapeKind>("wild");
  const deferred = useDeferredValue(query);
  const matches = useMemo(() => monsterMatcher(deferred), [deferred]);
  const rows = useMemo(
    () => (monsters ?? []).filter((m) => (!beastsOnly || isBeast(m)) && matches(m)).map((m): ListedRow => ({ key: m.srdId, view: m, source: "srd" })),
    [monsters, beastsOnly, matches],
  );
  const name = props.character.name;

  if (picked) {
    const take = () => {
      if (actions.dispatch({ t: "character.update", characterId: props.character.id, patch: { actor: shapePatch(picked.srdId, kind) } }) !== null) props.onClose();
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
        <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
          <ShapeChoice name={name} creature={picked.name} value={kind} onChange={setKind} />
          <Help>{`The token keeps ${whose(name)} HP, conditions and Passive Perception in either shape.`}</Help>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title="Take a shape" onClose={props.onClose} phone="fill" width="md">
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
        <Help>{`An SRD creature for ${whose(name)} token to take the shape of. The token keeps ${whose(name)} HP and conditions.`}</Help>
        <Input type="search" aria-label="Search creatures" placeholder="Search: wolf, cr 0-1" value={query} enterKeyHint="search" onChange={(e) => setQuery(e.target.value)} style={{ width: "100%" }} />
        <Checkbox label="Beasts only" checked={beastsOnly} onChange={setBeastsOnly} />
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
function ShapeChoice(props: { name: string; creature: string; value: ShapeKind; onChange(kind: ShapeKind): void }) {
  const group = useId();
  const options: { value: ShapeKind; label: string; detail: string }[] = [
    { value: "wild", label: "Wild Shape", detail: `${props.name} keeps Intelligence, Wisdom, Charisma and proficiencies, and each save and skill takes the higher of the two.` },
    { value: "other", label: "Polymorph or another shape", detail: `All of ${props.creature}’s numbers.` },
  ];
  return (
    <div role="radiogroup" aria-label="Which shape" style={{ display: "grid", gap: theme.space(1) }}>
      {options.map((o) => (
        <label key={o.value} style={{ display: "flex", alignItems: "flex-start", gap: theme.space(3), minHeight: theme.touch, padding: `${theme.space(2)}px 0`, cursor: "pointer" }}>
          <input type="radio" name={group} value={o.value} checked={props.value === o.value} onChange={() => props.onChange(o.value)} style={{ width: 22, height: 22, margin: 0, flex: "none", accentColor: theme.color.accent }} />
          <span style={{ display: "grid", gap: theme.space(0.5) }}>
            <strong>{o.label}</strong>
            <span style={{ color: theme.color.textMuted }}>{o.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
