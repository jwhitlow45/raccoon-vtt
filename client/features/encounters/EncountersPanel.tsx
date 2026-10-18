import { useDeferredValue, useMemo, useState } from "react";
import type { CustomMonster, PartyGroup, SavedEncounter, SavedEncounterMonster } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { MAX_ENCOUNTER_CREATURES, MAX_ENCOUNTER_KINDS, MAX_PARTY_GROUPS, savedEncounterInputSchema } from "#shared/protocol.ts";
import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import { MAX_LEVEL, MIN_LEVEL } from "#shared/srd/xp-budget.ts";
import { usePanelHeader, type PanelProps } from "../panels.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Empty } from "../../components/Empty.tsx";
import { ErrorText, Input, Select } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Row } from "../../components/Row.tsx";
import { useUnsavedInput, useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { viewOf } from "../monsters/draft.ts";
import { currentStageCamera } from "../scenes/stageCamera.ts";
import type { Point } from "../tokens/factory.ts";
import { PLACE_TOOL_ID, setPending } from "../tokens/placement.ts";
import { hasLairValues } from "../tokens/factory.ts";
import { useMonsterFilters } from "../tokens/filterState.ts";
import { filterCount } from "../tokens/monsterFilters.ts";
import { MonsterFilterBar } from "../tokens/MonsterFilters.tsx";
import { monsterMatcher } from "../tokens/monsterSearch.ts";
import { RoomBadge } from "../monsters/MonsterList.tsx";
import { ConfirmButton, Stepper } from "../tokens/ui.tsx";
import { DIFFICULTY_LABEL, difficultyOf, encounterXp, partyBudgets, partyFromCharacters, partySize, xpText } from "./budget.ts";
import { BudgetView } from "./Budget.tsx";
import { dropPlan, sendDrop, type DropOptions } from "./drop.ts";
import {
  addGroup,
  addMonster,
  creatureCount,
  draftOf,
  emptyDraft,
  encounterInput,
  encounterPatch,
  lineKey,
  lineXp,
  monsterXps,
  removeLine,
  resolveLine,
  roomLeft,
  setCount,
  setGroup,
  setLair,
  type Draft,
  type MonsterRef,
} from "./draft.ts";
import { useSrdMonsters, type SrdList } from "./useSrd.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";

/**
 * The DM's encounter builder (features section 10, v1): fights built ahead
 * from the SRD 5.2.1 monsters and the room's own, each with a count, weighed
 * against the party's 2024 XP budget, and saved in the room for later.
 * Players never receive a saved encounter (design 7.3), only the tokens it
 * places.
 */

const LEVEL_OPTIONS = Array.from({ length: MAX_LEVEL - MIN_LEVEL + 1 }, (_, i) => ({ value: String(i + MIN_LEVEL), label: `Level ${i + MIN_LEVEL}` }));

/** Search results shown at once. More than this and the DM types more or filters. */
const MAX_RESULTS = 30;

export default function EncountersPanel(props: PanelProps) {
  const srd = useSrdMonsters();
  const [open, setOpen] = useState<{ id: string | null; key: number } | null>(null);
  if (open) {
    return (
      <Builder
        key={open.key}
        id={open.id}
        srd={srd}
        close={props.close}
        onBack={() => setOpen(null)}
        onSaved={(id) => setOpen({ id, key: open.key + 1 })}
      />
    );
  }
  return <EncounterList srd={srd} onOpen={(id) => setOpen({ id, key: 0 })} />;
}

function useRoomMonsters(): Readonly<Record<string, CustomMonster>> | undefined {
  return useRoomView((s) => s.view?.monsters);
}

/** The party a saved encounter's budget is for: its own, or the room's characters as they are now. */
function useDefaultParty(): ReturnType<typeof partyFromCharacters> {
  const characters = useRoomView((s) => s.view?.characters);
  return useMemo(() => partyFromCharacters(Object.values(characters ?? {})), [characters]);
}

function SrdStatus(props: { srd: SrdList }) {
  if (props.srd.failed) {
    return (
      <SrdLoadFailed what="The SRD monster list" reopen={{ panel: "encounters" }} />
    );
  }
  return props.srd.list ? null : <Loading text="Loading the monsters…" />;
}

function EncounterList(props: { srd: SrdList; onOpen(id: string | null): void }) {
  const saved = useRoomView((s) => s.view?.savedEncounters);
  const monsters = useRoomMonsters();
  const party = useDefaultParty();
  const list = useMemo(() => Object.values(saved ?? {}).sort((a, b) => a.name.localeCompare(b.name)), [saved]);
  const full = list.length >= LIMITS.savedEncountersPerRoom;
  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      {/* The editor's openers carry ids, so Back finds the one pressed even after a save renames its row and moves it in the list (features/panels.ts useSubpageFocus). */}
      <Button variant="primary" size="sm" block onClick={() => props.onOpen(null)} disabled={full} data-opener="encounter-new">
        New encounter
      </Button>
      {full ? <Help>This room holds at most {LIMITS.savedEncountersPerRoom} encounters. Delete one to build another.</Help> : null}
      {list.length === 0 ? (
        <Empty>
          Build a fight ahead from the SRD monsters and this room’s own, see it against the party’s XP budget, and place it on any map when the time comes. Players never see these, only the tokens placed.
        </Empty>
      ) : null}
      <SrdStatus srd={props.srd} />
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(1) }}>
        {list.map((e) => (
          <li key={e.id}>
            <Row onClick={() => props.onOpen(e.id)} title={e.name} detail={summary(e, props.srd, monsters, party.groups)} opener={`encounter-${e.id}`} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "7 creatures · 1,250 XP · Moderate", once every stat block is at hand. */
function summary(e: SavedEncounter, srd: SrdList, monsters: Readonly<Record<string, CustomMonster>> | undefined, roomParty: PartyGroup[]): string {
  const count = creatureCount(e.monsters);
  const parts = [count === 1 ? "1 creature" : `${count} creatures`];
  const xp = encounterXp(monsterXps(e.monsters, (m) => resolveLine(m, srd.byId, monsters)));
  if (xp.unknown === 0) {
    parts.push(xpText(xp.total));
    const fits = difficultyOf(xp.total, partyBudgets(e.party ?? roomParty));
    if (fits) parts.push(fits === "over" ? "over High" : DIFFICULTY_LABEL[fits]);
  }
  return parts.join(" · ");
}

function Builder(props: { id: string | null; srd: SrdList; close(): void; onBack(): void; onSaved(id: string): void }) {
  const actions = useRoomActions();
  const saved = useRoomView((s) => (props.id === null ? undefined : s.view?.savedEncounters[props.id]));
  const monsters = useRoomMonsters();
  const roomParty = useDefaultParty();
  const [draft, setDraft] = useState<Draft>(() => (saved ? draftOf(saved) : emptyDraft()));
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const resolve = (m: SavedEncounterMonster) => resolveLine(m, props.srd.byId, monsters);
  const party = draft.party ?? roomParty.groups;
  const xp = encounterXp(monsterXps(draft.monsters, resolve));
  const missingRoomMonster = draft.monsters.some((m) => "monsterId" in m && !monsters?.[m.monsterId]);
  const changed = saved ? encounterPatch(saved, draft) !== null : draft.monsters.length > 0 || draft.name.trim() !== "" || draft.party !== null;
  // A sheet's swipe springs back while the editor holds changes, and its Back still asks (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(changed);
  const named = draft.name.trim() !== "";

  const edit = (next: Draft) => {
    setDraft(next);
    setError(null);
    setLeaving(false);
  };

  const save = () => {
    if (!named) return;
    // Saving answers the back button's question, so it stops asking until the next tap on it.
    setLeaving(false);
    if (saved) {
      const patch = encounterPatch(saved, draft);
      if (!patch) return;
      if (actions.dispatch({ t: "savedEncounter.update", encounterId: saved.id, patch }) === null) setError("This encounter could not be saved.");
      return;
    }
    // A new one, or one deleted on another device while it was open here, which saving makes again.
    const input = encounterInput(actions.newId(), draft);
    const checked = savedEncounterInputSchema.safeParse(input);
    if (!checked.success) {
      setError(`This encounter could not be saved: ${checked.error.issues[0]?.message ?? "it is not valid"}.`);
      return;
    }
    if (actions.dispatch({ t: "savedEncounter.create", encounter: input }) !== null) props.onSaved(input.id);
    else setError("This encounter could not be saved.");
  };

  // The header's back button. With unsaved changes the first tap stays and asks "Discard changes?", the second leaves, and any edit in between disarms it.
  const back = () => {
    if (changed && !leaving) {
      setLeaving(true);
      return;
    }
    props.onBack();
  };

  usePanelHeader({
    title: draft.name.trim() || saved?.name || "New encounter",
    parent: "Encounters",
    id: props.id ?? "new",
    onBack: back,
    armed: leaving ? "Discard changes?" : null,
  });

  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <Input
          type="text"
          aria-label="Encounter name"
          placeholder="Name: Ambush at the ford"
          maxLength={80}
          value={draft.name}
          enterKeyHint="done"
          onChange={(e) => edit({ ...draft, name: e.target.value })}
          style={{ flex: "1 1 180px" }}
        />
        <Button variant="primary" size="sm" onClick={save} disabled={!changed || !named} style={{ flex: "none" }}>
          {saved ? (changed ? "Save" : "Saved") : "Save encounter"}
        </Button>
      </div>
      {!named && draft.monsters.length > 0 ? <Help>Name it to save it.</Help> : null}
      {props.id !== null && !saved ? <Notice>This encounter was deleted on another device. Saving makes it again.</Notice> : null}
      <ErrorText>{error}</ErrorText>

      <Section label={`Monsters (${creatureCount(draft.monsters)})`}>
        {draft.monsters.length === 0 ? <Help>Add monsters below. Each tap adds one more.</Help> : null}
        {draft.monsters.map((m, i) => (
          <MonsterLine
            key={`${i}:${lineKey(m)}`}
            line={m}
            view={resolve(m)?.view ?? null}
            loading={"srdId" in m && !props.srd.list}
            room={"monsterId" in m}
            maxCount={m.count + roomLeft(draft)}
            onCount={(n) => edit(setCount(draft, i, n))}
            onLair={(on) => edit(setLair(draft, i, on))}
            onRemove={() => edit(removeLine(draft, i))}
          />
        ))}
        <AddMonsters srd={props.srd} monsters={monsters} draft={draft} onAdd={(ref) => edit(addMonster(draft, ref))} />
      </Section>

      <PlaceSection draft={draft} srd={props.srd} close={props.close} />

      <Section label="Party">
        <PartyEditor party={draft.party} roomParty={roomParty} onChange={(next) => edit({ ...draft, party: next })} />
      </Section>

      <Section label="XP budget">
        <BudgetView
          party={party}
          total={xp.total}
          unknown={xp.unknown}
          unknownWhy={missingRoomMonster ? "a monster of this room was deleted since. Remove its line." : "the SRD monsters are still loading."}
        />
        <Help>From the SRD 5.2.1 XP Budget per Character table: each character adds its level’s budget, and the monsters’ XP from their stat blocks must stay within it.</Help>
      </Section>

      {saved ? (
        <Section label="Remove">
          <ConfirmButton icon="delete" confirm="Tap again to delete" onConfirm={() => actions.dispatch({ t: "savedEncounter.delete", encounterId: saved.id }) !== null && props.onBack()}>
            Delete encounter
          </ConfirmButton>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * Placing the encounter on the scene this DM views: around the spot tapped
 * next with the Add token tool, or around the middle of the view at once.
 * It places what the builder shows, saved or not, and one undo takes it all
 * back.
 */
function PlaceSection(props: { draft: Draft; srd: SrdList; close(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const store = useRoomStore();
  const sceneName = useRoomView((s) => (s.sceneId ? s.view?.scenes[s.sceneId]?.name : undefined));
  const fighting = useRoomView((s) => (s.view?.encounter ?? null) !== null);
  const monsters = useRoomMonsters();
  const [hidden, setHidden] = useState(false);
  const [addToFight, setAddToFight] = useState(true);
  // Only Place sends the choices, so a sheet's swipe springs back once either changed (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince({ hidden, addToFight });
  const lines = props.draft.monsters;
  const waiting = lines.some((m) => "srdId" in m) && !props.srd.list;
  const deleted = lines.filter((m) => "monsterId" in m && !monsters?.[m.monsterId]).reduce((n, m) => n + m.count, 0);
  const count = creatureCount(lines) - deleted;
  const options: DropOptions = { hidden, addToFight: fighting && addToFight };
  const srdById = props.srd.byId;
  const name = props.draft.name.trim() || "this encounter";

  /** The plan from the room as it is when the tokens go down, so a monster's image set in between is the one placed. */
  const place = (state: Parameters<typeof dropPlan>[0]["state"] | null, scene: { id: string; bounds: { w: number; h: number } } | undefined, center: Point): string | null => {
    if (!state || !scene) return null;
    const plan = dropPlan({ monsters: lines, resolve: (m) => resolveLine(m, srdById, state.monsters), state, scene, center, options, newId: actions.newId });
    return sendDrop(plan, actions);
  };

  const atTap = () => {
    setPending(scope, {
      kind: "batch",
      what: hidden ? `${name}, hidden` : name,
      place: (world, ctx) => place(ctx.getState().view, ctx.scene, world),
    });
    ui.setTool(PLACE_TOOL_ID);
    props.close();
  };

  const atMiddle = () => {
    const s = store.getState();
    const scene = s.sceneId ? s.view?.scenes[s.sceneId] : undefined;
    if (!scene) return;
    const live = currentStageCamera(scope);
    const center = live
      ? { x: (live.viewport.width / 2 - live.camera.x) / live.camera.scale, y: (live.viewport.height / 2 - live.camera.y) / live.camera.scale }
      : { x: scene.bounds.w / 2, y: scene.bounds.h / 2 };
    const placed = place(s.view, scene, center);
    if (!placed) return;
    ui.select(placed);
    props.close();
  };

  const ready = count > 0 && !waiting && sceneName !== undefined;
  return (
    <Section label="Place on the map">
      {count === 0 && !waiting ? <Help>Add monsters to place them.</Help> : null}
      {waiting ? <Loading text="Loading the monsters…" /> : null}
      {deleted > 0 ? <Notice>{deleted === 1 ? "1 creature" : `${deleted} creatures`} of a monster deleted from this room will be left out.</Notice> : null}
      <div>
        <Checkbox checked={hidden} onChange={setHidden} label="Hidden from players" help="Reveal them later from their tokens." />
        {fighting ? <Checkbox checked={addToFight} onChange={setAddToFight} label="Add them to the fight" help="Each gets a row, grouped with the same monsters for one initiative value." /> : null}
      </div>
      {/* One above the other: side by side, the longer label runs past a 360 px side panel. */}
      <div style={{ display: "grid", gap: theme.space(2) }}>
        <Button variant="primary" size="sm" disabled={!ready} onClick={atTap}>
          Place where I tap
        </Button>
        <Button size="sm" disabled={!ready} onClick={atMiddle}>
          Place in the middle of the view
        </Button>
      </div>
      {ready ? (
        <Help>
          {count === 1 ? "1 creature goes" : `${count} creatures go`} on {sceneName}, the scene you are viewing, with {count === 1 ? "its monster’s image" : "their monsters’ images"}. One undo takes {count === 1 ? "it" : "them"} back off the map.
        </Help>
      ) : null}
    </Section>
  );
}

function MonsterLine(props: {
  line: SavedEncounterMonster;
  view: StatBlockMonster | null;
  loading: boolean;
  room: boolean;
  maxCount: number;
  onCount(n: number): void;
  onLair(on: boolean): void;
  onRemove(): void;
}) {
  const { line, view } = props;
  const name = view ? view.name : props.loading ? "Loading…" : "A monster deleted from this room";
  return (
    <div
      style={{
        display: "grid",
        gap: theme.space(1),
        padding: `${theme.space(2)}px ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.surfaceRaised,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.input, fontWeight: theme.weight.strong, color: view ? theme.color.text : theme.color.textMuted }}>{name}</span>
        {props.room ? <RoomBadge /> : null}
        {view ? (
          <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, whiteSpace: "nowrap" }}>
            CR {view.cr} · {xpText(lineXp(line, view))} each
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
        <Stepper label={`How many ${view?.name ?? "of this monster"}`} value={line.count} step={1} min={1} max={props.maxCount} onChange={props.onCount} />
        <span style={{ flex: 1 }} />
        <Button variant="danger" size="sm" onClick={props.onRemove} aria-label={`Remove ${view?.name ?? "this monster"}`} title={`Remove ${view?.name ?? "this monster"}`}>
          Remove
        </Button>
      </div>
      {view && hasLairValues(view) ? <Checkbox checked={line.inLair === true} onChange={props.onLair} label="In its lair" help="Uses the lair’s legendary uses and XP." /> : null}
    </div>
  );
}

type Candidate = { key: string; ref: MonsterRef; view: StatBlockMonster; room: boolean };

function AddMonsters(props: { srd: SrdList; monsters: Readonly<Record<string, CustomMonster>> | undefined; draft: Draft; onAdd(ref: MonsterRef): void }) {
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim());
  const { filters, setFilters } = useMonsterFilters();
  const deferredFilters = useDeferredValue(filters);
  // With neither a search nor a filter, the list offers only the room's own rather than the first 30 of 330.
  const searching = deferred !== "" || filterCount(deferredFilters) > 0;
  const own = useMemo(
    () =>
      Object.values(props.monsters ?? {})
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((m): Candidate => ({ key: `room:${m.id}`, ref: { monsterId: m.id }, view: viewOf(m), room: true })),
    [props.monsters],
  );
  const srd = useMemo(() => (props.srd.list ?? []).map((m): Candidate => ({ key: `srd:${m.srdId}`, ref: { srdId: m.srdId }, view: m, room: false })), [props.srd.list]);
  const results = useMemo(() => {
    if (!searching) return own;
    const matches = monsterMatcher(deferred, deferredFilters);
    return [...own, ...srd].filter((c) => matches(c.view));
  }, [own, srd, deferred, deferredFilters, searching]);
  const full = roomLeft(props.draft) <= 0;
  const kindsFull = props.draft.monsters.length >= MAX_ENCOUNTER_KINDS;
  return (
    <div style={{ display: "grid", gap: theme.space(2), marginTop: theme.space(1) }}>
      <MonsterFilterBar filters={filters} onChange={setFilters} count={props.srd.list ? (searching ? results.length : own.length + srd.length) : null}>
        <Input
          type="search"
          aria-label="Search monsters to add"
          placeholder="Add: goblin, cr 1-5"
          value={query}
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, width: "100%" }}
        />
      </MonsterFilterBar>
      {full ? <Help>An encounter holds at most {MAX_ENCOUNTER_CREATURES} creatures.</Help> : null}
      {searching ? <SrdStatus srd={props.srd} /> : null}
      {!searching && own.length === 0 ? <Help>Search or filter the 330 SRD monsters and this room’s own.</Help> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(1) }}>
        {results.slice(0, MAX_RESULTS).map((c) => {
          const has = props.draft.monsters.some((m) => ("srdId" in c.ref ? "srdId" in m && m.srdId === c.ref.srdId : "monsterId" in m && m.monsterId === c.ref.monsterId) && !m.inLair);
          const blocked = full || (kindsFull && !has);
          return (
            <li key={c.key}>
              <Row
                label={`Add one ${c.view.name}`}
                disabled={blocked}
                onClick={() => props.onAdd(c.ref)}
                leading={<Icon name="plus" size="sm" />}
                title={c.view.name}
                trailing={
                  <>
                    {c.room ? <RoomBadge /> : null}
                    <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, whiteSpace: "nowrap" }}>
                      CR {c.view.cr} · {xpText(c.view.xp)}
                    </span>
                  </>
                }
              />
            </li>
          );
        })}
      </ul>
      {results.length > MAX_RESULTS ? <Help>{results.length - MAX_RESULTS} more. Type more or add a filter to narrow the list.</Help> : null}
      {searching && results.length === 0 && props.srd.list ? (
        <Help>{deferred === "" ? "No monster matches the filters." : filterCount(deferredFilters) > 0 ? `No monster matches “${deferred}” with the filters.` : `No monster matches “${deferred}”.`}</Help>
      ) : null}
      {kindsFull && !full ? <Help>An encounter holds at most {MAX_ENCOUNTER_KINDS} kinds of monster.</Help> : null}
    </div>
  );
}

/**
 * The party the budget is for. By default the room's player characters by
 * level, followed live, and a character without a level is named rather
 * than guessed at. Editing makes the party the encounter's own, saved with
 * it, for a fight planned for another table size or a level to come.
 */
function PartyEditor(props: { party: PartyGroup[] | null; roomParty: ReturnType<typeof partyFromCharacters>; onChange(next: PartyGroup[] | null): void }) {
  const { party, roomParty } = props;
  if (party === null) {
    const size = partySize(roomParty.groups);
    return (
      <>
        <Help>The room’s characters{size > 0 ? `: ${groupsText(roomParty.groups)}` : ""}.</Help>
        {roomParty.unleveled.length > 0 ? (
          <Notice>
            The budget leaves out {listText(roomParty.unleveled)}, who {roomParty.unleveled.length === 1 ? "has" : "have"} no level yet. Set one on {roomParty.unleveled.length === 1 ? "the" : "each"} character’s card, or edit the party here.
          </Notice>
        ) : null}
        {size === 0 && roomParty.unleveled.length === 0 ? <Help>This room has no characters yet. Edit the party to budget for one.</Help> : null}
        <Button size="sm" onClick={() => props.onChange(roomParty.groups.length > 0 ? roomParty.groups : [{ count: Math.max(1, roomParty.unleveled.length), level: 1 }])}>
          Edit the party
        </Button>
      </>
    );
  }
  return (
    <>
      {party.map((g, i) => (
        <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
          <Stepper label="Characters" value={g.count} step={1} min={1} max={LIMITS.charactersPerRoom} onChange={(count) => props.onChange(setGroup(party, i, { ...g, count }, LIMITS.charactersPerRoom))} />
          <div style={{ flex: "1 1 120px", display: "flex" }}>
            <Select
              aria-label="Their level"
              value={String(g.level)}
              onChange={(e) => props.onChange(setGroup(party, i, { ...g, level: Number(e.target.value) }, LIMITS.charactersPerRoom))}
              style={{ flex: 1, maxWidth: "100%" }}
            >
              {LEVEL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="danger" size="sm" aria-label="Remove this level" title="Remove this level" onClick={() => props.onChange(party.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      {party.length === 0 ? <Help>No characters: add a level for the budget.</Help> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button size="sm" onClick={() => props.onChange(addGroup(party))} disabled={party.length >= MAX_PARTY_GROUPS}>
          Add a level
        </Button>
        <Button size="sm" onClick={() => props.onChange(null)}>
          Use the room’s characters
        </Button>
      </div>
    </>
  );
}

/** "4 at level 3, 1 at level 4". */
function groupsText(groups: readonly PartyGroup[]): string {
  return groups.map((g) => `${g.count} at level ${g.level}`).join(", ");
}

/** "Thorn", "Thorn and Vex", "Ash, Thorn and Vex". */
function listText(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
