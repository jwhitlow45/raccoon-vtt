import { useDeferredValue, useMemo, useState } from "react";
import type { Character } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Input } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { characterBlocks, countLabel, pickerLists, whose, type PickerRow } from "../tokens/companionBlocks.ts";
import { monsterMatcher } from "../tokens/monsterSearch.ts";
import { viewOf } from "./draft.ts";
import { MonsterList, type Listed } from "./MonsterList.tsx";
import { SrdCredit, useSrdMonsters } from "./StatBlockView.tsx";
import { nameSuggestions, type BlockLink, type Suggestion } from "./statBlockLink.ts";
import { SrdLoadFailed } from "./SrdLoadFailed.tsx";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * The monster browser for "Attach a stat block" on a token that is not a
 * companion (docs/design-v1-dm-tools.md 3.6): the room's own monsters and
 * the SRD's, searched as the Monsters panel searches, with those of exactly
 * the token's name suggested first. A tap attaches and closes. A
 * companion's picker is CompanionPickerBody, in a dialog of its own steps.
 */
export function MonsterPicker(props: { name: string; onPick(link: BlockLink): void; onClose(): void }) {
  const { monsters, failed } = useSrdMonsters();
  const roomMonsters = useRoomView((s) => s.view?.monsters);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const own = useMemo(
    () => Object.values(roomMonsters ?? {}).sort(byName).map((m): Listed => ({ key: `room:${m.id}`, source: "room", monster: m, view: viewOf(m) })),
    [roomMonsters],
  );
  const srd = useMemo(() => (monsters ?? []).map((m): Listed => ({ key: `srd:${m.srdId}`, source: "srd", srd: m, view: m })), [monsters]);
  const suggested = useMemo(
    () => nameSuggestions(props.name, own.flatMap((l): Suggestion[] => (l.source === "room" ? [{ key: l.key, link: { monsterId: l.monster.id }, view: l.view, source: "room" }] : [])), monsters ?? []),
    [props.name, own, monsters],
  );
  const matches = useMemo(() => monsterMatcher(deferred), [deferred]);
  const ownResults = useMemo(() => own.filter((m) => matches(m.view)), [own, matches]);
  const srdResults = useMemo(() => srd.filter((m) => matches(m.view)), [srd, matches]);

  const pick = (key: string) => {
    const listed = own.find((m) => m.key === key) ?? srd.find((m) => m.key === key);
    if (!listed) return;
    props.onPick(listed.source === "room" ? { monsterId: listed.monster.id } : { srdId: listed.srd.srdId });
  };

  return (
    <Dialog title="Attach a stat block" onClose={props.onClose} phone="fill" width="md">
      <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
        <Help>Links the block only. The token keeps its own HP, AC and Speeds.</Help>
        {suggested.length > 0 ? (
          <>
            <ListLabel>Same name</ListLabel>
            <MonsterList items={suggested} onPick={pick} />
          </>
        ) : null}
        <SearchField value={query} onChange={setQuery} placeholder="Search: goblin, cr 1-5" />
        {own.length > 0 ? (
          <>
            <ListLabel>{`This room's monsters ${countLabel(ownResults.length, own.length)}`}</ListLabel>
            <MonsterList items={ownResults} onPick={pick} />
          </>
        ) : null}
        <ListLabel>{monsters ? `SRD 5.2.1 ${countLabel(srdResults.length, srd.length)}` : "SRD 5.2.1"}</ListLabel>
        {failed ? <SrdLoadFailed what="The monster list" /> : null}
        {!monsters && !failed ? <Loading text="Loading the monsters…" /> : null}
        <MonsterList items={srdResults} onPick={pick} />
        <SrdCredit />
      </div>
    </Dialog>
  );
}

/**
 * A companion's picker (docs/design-v1-companion-stat-blocks.md 6.1), the
 * body of a dialog its caller owns, so a pick can move it to the numbers
 * step in place and Back finds the search as it was: "Paste a stat block"
 * and "New stat block", then the character's own blocks, those of exactly
 * the companion's name, the search and the SRD's 330 with its credit. No
 * room monster is listed, for the DM either, so every block offered is one
 * the companion's players read. The SRD chunk loads with it, behind the
 * shared indicator, and the character's blocks list at once from the view.
 */
export function CompanionPickerBody(props: {
  character: Pick<Character, "id" | "name">;
  /** The companion's name, for the blocks of exactly that name. Empty in a new companion's form until it has one. */
  name: string;
  /** The line at the top: what attaching does, or what choosing one does. */
  help: string;
  query: string;
  onQuery(query: string): void;
  onPick(row: PickerRow): void;
  onPaste(): void;
  onNew(): void;
}) {
  const { monsters, failed } = useSrdMonsters();
  const stored = useRoomView((s) => s.view?.companionBlocks);
  const deferred = useDeferredValue(props.query);
  const blocks = useMemo(() => characterBlocks({ companionBlocks: stored ?? {} }, props.character.id), [stored, props.character.id]);
  const lists = useMemo(
    () => pickerLists({ name: props.name, query: deferred, blocks, characterName: props.character.name, srd: monsters }),
    [props.name, deferred, blocks, props.character.name, monsters],
  );
  const rows = useMemo(() => new Map([...lists.own, ...lists.sameName, ...lists.srd].map((r) => [r.key, r])), [lists]);
  const pick = (key: string) => {
    const row = rows.get(key);
    if (row) props.onPick(row);
  };
  return (
    // The help and the list labels name the character, whose name may be long and unbroken: it wraps rather than run out of the picker.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
      <Help>{props.help}</Help>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button size="sm" onClick={props.onPaste}>
          Paste a stat block
        </Button>
        <Button size="sm" onClick={props.onNew}>
          New stat block
        </Button>
      </div>
      {/* Above every list it narrows, the character's own included, so typing never changes a list out of view above it. */}
      <SearchField value={props.query} onChange={props.onQuery} placeholder="Search: owl, cr 0-1" />
      {lists.ownCount > 0 ? (
        <>
          <ListLabel>{`${whose(props.character.name)} stat blocks ${countLabel(lists.own.length, lists.ownCount)}`}</ListLabel>
          <MonsterList items={lists.own} onPick={pick} />
        </>
      ) : null}
      {lists.sameName.length > 0 ? (
        <>
          <ListLabel>Same name</ListLabel>
          <MonsterList items={lists.sameName.map((r) => ({ ...r, key: `same:${r.key}` }))} onPick={(key) => pick(key.slice("same:".length))} />
        </>
      ) : null}
      <ListLabel>{monsters ? `SRD 5.2.1 ${countLabel(lists.srd.length, monsters.length)}` : "SRD 5.2.1"}</ListLabel>
      {failed ? <SrdLoadFailed what="The monster list" /> : null}
      {!monsters && !failed ? <Loading text="Loading the monsters…" /> : null}
      <MonsterList items={lists.srd} onPick={pick} />
      <SrdCredit />
    </div>
  );
}

function SearchField(props: { value: string; onChange(value: string): void; placeholder: string }) {
  return (
    <Input
      type="search"
      aria-label="Search monsters"
      placeholder={props.placeholder}
      value={props.value}
      enterKeyHint="search"
      onChange={(e) => props.onChange(e.target.value)}
      style={{ width: "100%" }}
    />
  );
}

/** A list's label, with room above it so it reads as the start of the next list rather than the end of the last. */
function ListLabel(props: { children: string }) {
  return (
    <div style={{ paddingTop: theme.space(2) }}>
      <SectionLabel>{props.children}</SectionLabel>
    </div>
  );
}
