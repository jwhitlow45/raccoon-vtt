import { useDeferredValue, useMemo, useState } from "react";
import type { CustomMonster, ImageRef, StatBlock } from "#shared/model.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { emptyStatBlock, statBlockFromSrd, statBlockOf } from "#shared/statBlock.ts";
import { usePanelHeader, type PanelClose, type PanelProps } from "../panels.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Empty } from "../../components/Empty.tsx";
import { FieldRow, Input } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { viewOf } from "../monsters/draft.ts";
import { monsterImage, shippedImage, type MonsterRef } from "../monsters/images.ts";
import { MonsterEditor } from "../monsters/MonsterEditor.tsx";
import { MonsterImageSection } from "../monsters/MonsterImage.tsx";
import { MonsterList, RoomBadge, type Listed } from "../monsters/MonsterList.tsx";
import { SrdCredit, StatBlockView, useSrdMonsters } from "../monsters/StatBlockView.tsx";
import { hasLairValues } from "./factory.ts";
import { useMonsterFilters } from "./filterState.ts";
import { MonsterFilterBar } from "./MonsterFilters.tsx";
import { monsterMatcher } from "./monsterSearch.ts";
import { PLACE_TOOL_ID, setPending } from "./placement.ts";
import { ConfirmButton, NumberField, Stepper } from "./ui.tsx";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";

/**
 * The DM's monster browser (features section 15): the room's own monsters,
 * entered from books the group owns, and the 330 SRD 5.2.1 stat blocks.
 * Search and filter both, read one, drop one or several on the map with
 * average HP or a typed number, and create, paste, edit or delete the
 * room's own. The SRD blocks are about half a megabyte, so they load only
 * when this panel first opens, in their own chunk, and the room's own show
 * while they load.
 */

type Editing = { monster: CustomMonster | null; initial: StatBlock; paste: boolean };

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export default function MonstersPanel(props: PanelProps) {
  const { monsters, failed } = useSrdMonsters();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const { filters, setFilters } = useMonsterFilters();
  const deferredFilters = useDeferredValue(filters);
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const roomMonsters = useRoomView((s) => s.view?.monsters);
  const srdImages = useRoomView((s) => s.view?.srdImages);

  const own = useMemo(
    () => Object.values(roomMonsters ?? {}).sort(byName).map((m): Listed => ({ key: `room:${m.id}`, source: "room", monster: m, view: viewOf(m) })),
    [roomMonsters],
  );
  const srd = useMemo(() => (monsters ?? []).map((m): Listed => ({ key: `srd:${m.srdId}`, source: "srd", srd: m, view: m })), [monsters]);
  const matches = useMemo(() => monsterMatcher(deferred, deferredFilters), [deferred, deferredFilters]);
  const ownResults = useMemo(() => own.filter((m) => matches(m.view)), [own, matches]);
  const srdResults = useMemo(() => srd.filter((m) => matches(m.view)), [srd, matches]);
  // Found again on every render, so an edit shows at once and a monster deleted from another device closes its page.
  const detail = chosen === null ? undefined : (own.find((m) => m.key === chosen) ?? srd.find((m) => m.key === chosen));

  const editor = editing ? (
    <MonsterEditor
      monster={editing.monster}
      initial={editing.initial}
      paste={editing.paste}
      onClose={() => setEditing(null)}
      onSaved={(id) => {
        setEditing(null);
        setChosen(`room:${id}`);
      }}
    />
  ) : null;

  if (detail) {
    return (
      <>
        <MonsterDetail
          listed={detail}
          onBack={() => setChosen(null)}
          close={props.close}
          onEdit={(monster) => setEditing({ monster, initial: statBlockOf(monster), paste: false })}
          onCopy={(m) => {
            // The copy starts with the image the SRD monster's tokens get: the DM's choice, else its shipped icon.
            const image = monsterImage({ srdImages }, { srdId: m.srdId });
            setEditing({ monster: null, initial: { ...statBlockFromSrd(m), ...(image ? { defaultImage: image } : {}) }, paste: false });
          }}
          onDeleted={() => setChosen(null)}
        />
        {editor}
      </>
    );
  }

  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <MonsterFilterBar filters={filters} onChange={setFilters} count={monsters ? ownResults.length + srdResults.length : null}>
        <Input
          type="search"
          aria-label="Search monsters"
          placeholder="Search: goblin, cr 1-5"
          value={query}
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, width: "100%" }}
        />
      </MonsterFilterBar>
      {/* Saving a new monster opens it, so Back from there finds the button that started it by its id (features/panels.ts useSubpageFocus). */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button size="sm" style={{ flex: 1 }} onClick={() => setEditing({ monster: null, initial: emptyStatBlock(), paste: true })} data-opener="monster-paste">
          Paste a stat block
        </Button>
        <Button size="sm" style={{ flex: 1 }} onClick={() => setEditing({ monster: null, initial: emptyStatBlock(), paste: false })} data-opener="monster-new">
          New monster
        </Button>
      </div>
      <Section
        label={own.length === 0 ? "This room's monsters" : ownResults.length === own.length ? `This room's monsters (${own.length})` : `This room's monsters (${ownResults.length} of ${own.length})`}
      >
        {own.length > 0 ? (
          <MonsterList items={ownResults} onPick={setChosen} subpages />
        ) : (
          <Empty>Monsters from books the group owns go here, kept in this room and its backups only. Paste one or start a new one.</Empty>
        )}
      </Section>
      <Section label={monsters ? (srdResults.length === srd.length ? `SRD 5.2.1 (${srd.length})` : `SRD 5.2.1 (${srdResults.length} of ${srd.length})`) : "SRD 5.2.1"}>
        {failed ? (
          <SrdLoadFailed what="The monster list" reopen={{ panel: "monsters" }} />
        ) : null}
        {!monsters && !failed ? <Loading text="Loading the monsters…" /> : null}
        <MonsterList items={srdResults} onPick={setChosen} subpages />
        <SrdCredit />
      </Section>
      {editor}
    </div>
  );
}

function MonsterDetail(props: {
  listed: Listed;
  onBack(): void;
  close: PanelClose;
  onEdit(monster: CustomMonster): void;
  onCopy(monster: SrdMonster): void;
  onDeleted(): void;
}) {
  const { listed } = props;
  const m = listed.view;
  const ui = useRoomUi();
  const scope = useRoomScope();
  const actions = useRoomActions();
  const [count, setCount] = useState(1);
  const [typedHp, setTypedHp] = useState<number | null>(null);
  const [useTyped, setUseTyped] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [inLair, setInLair] = useState(false);
  // Only Place sends the choices, so a sheet's swipe springs back once any changed (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince({ count, typedHp, useTyped, hidden, inLair });
  const lair = hasLairValues(m);
  const srdImage = useRoomView((s) => (listed.source === "srd" ? s.view?.srdImages?.[listed.srd.srdId]?.image : undefined));
  const image = listed.source === "room" ? listed.monster.defaultImage : srdImage;
  const target = useMemo<MonsterRef>(() => (listed.source === "room" ? { monsterId: listed.monster.id } : { srdId: listed.srd.srdId }), [listed]);
  const fallback = useMemo(() => shippedImage(target), [target]);
  const setImage = (next: ImageRef | null) => {
    if ("srdId" in target) actions.dispatch({ t: "monster.setSrdImage", srdId: target.srdId, image: next });
    else actions.dispatch({ t: "monster.update", monsterId: target.monsterId, patch: { defaultImage: next } });
  };

  usePanelHeader({ title: m.name, parent: "Monsters", id: listed.key, onBack: props.onBack });

  const place = () => {
    const source = listed.source === "room" ? { monsterId: listed.monster.id } : {};
    setPending(scope, { kind: "monster", monster: m, ...source, count, hp: useTyped ? typedHp : null, hidden, inLair: lair && inLair });
    ui.setTool(PLACE_TOOL_ID);
    props.close({ placing: true });
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <div
        style={{
          display: "grid",
          gap: theme.space(1),
          padding: theme.space(3),
          borderRadius: theme.radius.md,
          background: theme.color.surfaceRaised,
          border: `${theme.line.border}px solid ${theme.color.border}`,
        }}
      >
        {/* The card's first line, so the page opens on the card and not on a line of its own above it. */}
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>CR {m.cr}</span>
          {listed.source === "room" ? <RoomBadge /> : null}
        </div>
        <FieldRow label="How many">
          <Stepper label="How many" value={count} step={1} min={1} max={20} onChange={setCount} />
        </FieldRow>
        <Checkbox
          checked={!useTyped}
          onChange={(avg) => setUseTyped(!avg)}
          label={`Average HP (${m.hp.average})`}
          help={m.hp.formula ? `The stat block's ${m.hp.formula}. Roll your own and type it below instead.` : "Type a number below instead."}
        />
        {useTyped ? (
          <FieldRow label="HP for each">
            <NumberField label="HP for each" value={typedHp ?? undefined} min={1} max={100_000} placeholder={String(m.hp.average)} onCommit={(n) => setTypedHp(n)} />
          </FieldRow>
        ) : null}
        <Checkbox checked={hidden} onChange={setHidden} label="Hidden from players" help="Reveal it later from its token." />
        {lair ? <Checkbox checked={inLair} onChange={setInLair} label="In its lair" help="Uses the lair's legendary uses and XP." /> : null}
        <Button variant="primary" size="sm" onClick={place} disabled={useTyped && typedHp === null}>
          {count === 1 ? "Place on the map" : `Place ${count} on the map`}
        </Button>
        <Help>Then tap the map where {count === 1 ? "it goes" : "they go"}.</Help>
      </div>
      <MonsterImageSection target={target} name={m.name} image={image} fallback={fallback} onChange={setImage} />
      {listed.source === "room" ? (
        <>
          <div style={{ display: "flex", gap: theme.space(2) }}>
            <Button size="sm" icon="edit" style={{ flex: 1 }} onClick={() => props.onEdit(listed.monster)}>
              Edit
            </Button>
            <ConfirmButton
              grow
              icon="delete"
              confirm="Tap again to delete"
              onConfirm={() => {
                if (actions.dispatch({ t: "monster.delete", monsterId: listed.monster.id }) !== null) props.onDeleted();
              }}
            >
              Delete
            </ConfirmButton>
          </div>
          <Help>This room's own monster. Players never see its stat block, only the tokens made from it. Deleting it leaves those tokens on the map.</Help>
        </>
      ) : (
        <Button size="sm" onClick={() => props.onCopy(listed.srd)}>
          Copy to this room's monsters and edit
        </Button>
      )}
      <StatBlockView view={m} source={listed.source} />
    </div>
  );
}
