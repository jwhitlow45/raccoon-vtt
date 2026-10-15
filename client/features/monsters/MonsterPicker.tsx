import { useDeferredValue, useMemo, useState } from "react";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Input } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { monsterMatcher } from "../tokens/monsterSearch.ts";
import { viewOf } from "./draft.ts";
import { MonsterList, type Listed } from "./MonsterList.tsx";
import { SrdCredit, useSrdMonsters } from "./StatBlockView.tsx";
import { nameSuggestions, type Suggestion } from "./statBlockLink.ts";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/**
 * The monster browser for "Attach a stat block" on a token
 * (docs/design-v1-dm-tools.md 3.6): the room's own monsters and the SRD's,
 * searched as the Monsters panel searches, with those of exactly the
 * token's name suggested first. A tap attaches and closes.
 */
export function MonsterPicker(props: { name: string; onPick(link: Suggestion["link"]): void; onClose(): void }) {
  const { monsters, failed, retry } = useSrdMonsters();
  const roomMonsters = useRoomView((s) => s.view?.monsters);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const own = useMemo(
    () => Object.values(roomMonsters ?? {}).sort(byName).map((m): Listed => ({ key: `room:${m.id}`, source: "room", monster: m, view: viewOf(m) })),
    [roomMonsters],
  );
  const srd = useMemo(() => (monsters ?? []).map((m): Listed => ({ key: `srd:${m.srdId}`, source: "srd", srd: m, view: m })), [monsters]);
  const suggested = useMemo(
    () => nameSuggestions(props.name, own.flatMap((l) => (l.source === "room" ? [{ monster: l.monster, view: l.view }] : [])), monsters ?? []),
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
        <Help>Links the block only. The token keeps its own HP, AC and speeds.</Help>
        {suggested.length > 0 ? (
          <>
            <ListLabel>Same name</ListLabel>
            <MonsterList items={suggested} onPick={pick} />
          </>
        ) : null}
        <Input
          type="search"
          aria-label="Search monsters"
          placeholder="Search: goblin, cr 1-5"
          value={query}
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: "100%" }}
        />
        {own.length > 0 ? (
          <>
            <ListLabel>{ownResults.length === own.length ? `This room’s monsters (${own.length})` : `This room’s monsters (${ownResults.length} of ${own.length})`}</ListLabel>
            <MonsterList items={ownResults} onPick={pick} />
          </>
        ) : null}
        <ListLabel>{monsters ? (srdResults.length === srd.length ? `SRD 5.2.1 (${srd.length})` : `SRD 5.2.1 (${srdResults.length} of ${srd.length})`) : "SRD 5.2.1"}</ListLabel>
        {failed ? (
          <Notice
            tone="danger"
            role="alert"
            action={
              <Button size="sm" onClick={retry}>
                Try again
              </Button>
            }
          >
            The monster list did not load.
          </Notice>
        ) : null}
        {!monsters && !failed ? <Loading text="Loading the monsters…" /> : null}
        <MonsterList items={srdResults} onPick={pick} />
        <SrdCredit />
      </div>
    </Dialog>
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
