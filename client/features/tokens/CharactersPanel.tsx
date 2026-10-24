import { useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { Character, CreatureSize, Member } from "#shared/model.ts";
import { usePanelHeader, type PanelClose, type PanelProps } from "../panels.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Empty } from "../../components/Empty.tsx";
import { ErrorText, FieldRow, Input, Select } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Help, Note, Section } from "../../components/Panel.tsx";
import { Row, RowList } from "../../components/Row.tsx";
import { handFocusNow, pressedControl } from "../../lib/handFocus.ts";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { hpDisplay, hpText, initials } from "../../lib/tokenView.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { dispatchGesture } from "../../state/actions.ts";
import type { OpAnswer } from "../../state/types.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { ImageField, type ImageRef } from "../images/ImageField.tsx";
import { ImagePreview } from "../images/IconDisk.tsx";
import { partyRestBackText } from "../resources/logic.ts";
import { ownsCharacter } from "./access.ts";
import { CharacterPage, myToken, SIZE_OPTIONS } from "./CharacterCard.tsx";
import { characterPageSlot, DISCARD, formFields, openForm, pageBackTo, patchForm, shownPage, staleList, useKeepDraft, useKeptDraft, useLeaveForm, usePendingNumbers, type LeaveFor } from "./characterPage.ts";
import { CharacterBlocksPage } from "./CompanionBlocks.tsx";
import { CompanionForm } from "./CompanionsSection.tsx";
import { CREATURE_HEADING } from "./CreatureHeader.tsx";
import { EffectIcon } from "./EffectIcon.tsx";
import { newCharacter } from "./factory.ts";
import { PLACE_TOOL_ID, setPending } from "./placement.ts";
import { newCharacterState } from "./playerCharacters.ts";
import { NumberField } from "./ui.tsx";

/**
 * Player characters (features section 15). The DM creates them, picks who
 * plays each one, edits every character and places their tokens. A player
 * sees and edits their own, and the rest of the party as the projection
 * shows them: name, conditions and the HP the DM allows. When the room
 * lets players create characters, a player also makes their own (theirs
 * alone, a few at most) and puts their tokens on the players' scene. A
 * player deletes a character they play alone, whoever made it.
 *
 * A character's row opens its page (docs/design-v1-look-pass.md 3.1), the
 * panel's subpage, named by the character with "Back to Characters" in the
 * sheet's or side panel's header (usePanelHeader). Which page is open lives
 * in the Room's scope (characterPage.ts), so a companion's link in the
 * token panel can open its character's page here.
 */
export default function CharactersPanel(props: PanelProps) {
  const you = useRoomView((s) => s.you);
  const view = useRoomView((s) => s.view);
  const characters = useRoomView((s) => s.view?.characters);
  const pageStore = useScoped(characterPageSlot);
  const picked = useStore(pageStore, (s) => s.characterId);
  const opened = useStore(pageStore, (s) => s.opened);
  /*
   * The form in the panel's place lives in the slot beside the page, so the
   * remount a crossing of 900 px makes keeps it: New character, the
   * character whose "Add a companion" form shows, or the character whose
   * stat blocks page shows (docs/design-v1-companion-stat-blocks.md 6.4).
   */
  const shownForm = useStore(pageStore, useShallow(formFields));
  const formId = shownForm?.id ?? "";
  const closeForm = () => patchForm(pageStore, formId, () => null);
  const creating = shownForm?.kind === "new";
  const addingFor = shownForm?.kind === "companion" ? shownForm.characterId : null;
  const blocksFor = shownForm?.kind === "blocks" ? shownForm.characterId : null;
  const since = shownForm?.opened ?? 0;
  const dm = you?.role === "dm";

  const list = useMemo(
    () => Object.values(characters ?? {}).filter((c): c is Character => !!c).sort((a, b) => a.name.localeCompare(b.name)),
    [characters],
  );
  const mine = list.filter((c) => dm || ownsCharacter(you?.memberId, c));
  const others = dm ? [] : list.filter((c) => !ownsCharacter(you?.memberId, c));
  const openId = shownPage(picked, mine, dm);
  const page = openId !== null ? mine.find((c) => c.id === openId) : undefined;
  const openPage = (characterId: string | null) => pageStore.setState({ characterId });
  // A page a player landed on stays theirs to leave by Back, even once a second character arrives.
  useEffect(() => {
    if (picked === undefined && openId !== null) pageStore.setState({ characterId: openId });
  }, [picked, openId, pageStore]);

  const own = !dm && view && you ? newCharacterState(view, you.memberId) : null;

  const root = useRef<HTMLDivElement>(null);
  const remove = useDeleteHandOff(root, mine, (characterId) => {
    // A page whose character went shows the list from now on, so the id never comes back to a later page.
    if (pageStore.getState().characterId === characterId) openPage(null);
  });

  /*
   * New character, Add a companion and a character's stat blocks are
   * subpages too, each naming itself in the header (docs/design-v1-look-pass.md
   * 3.1). They name the control that opened them in their `backTo`, so
   * leaving one hands focus back to it on the page it returns to.
   */
  const companionOf = addingFor !== null ? characters?.[addingFor] : undefined;
  const blocksOf = blocksFor !== null ? characters?.[blocksFor] : undefined;
  const form = companionOf !== undefined || blocksOf !== undefined || creating;
  // A page opened from outside the panel takes the stat blocks page's place at once, an open made while the panel was away included: it holds nothing typed. The forms leave through their own question (useLeaveForm).
  useEffect(() => {
    pageStore.setState((s) => (staleList(s) ? { form: null } : {}));
  }, [opened, shownForm, pageStore]);
  usePanelHeader(
    page && !form
      ? {
          title: page.name,
          parent: "Characters",
          id: `character:${page.id}`,
          backTo: pageBackTo(page.id, mine),
          onBack: () => openPage(null),
        }
      : null,
  );

  if (companionOf) {
    // Back where it came from, its character's page, which a page opened from outside may have taken the slot from while the form stayed.
    const done = (to: LeaveFor) => {
      closeForm();
      if (to === "back") openPage(companionOf.id);
    };
    return <CompanionForm key={formId} formId={formId} since={since} character={companionOf} shown={props.shown} close={props.close} opened={opened} onDone={done} />;
  }
  if (blocksOf) return <CharacterBlocksPage character={blocksOf} onBack={closeForm} />;
  if (creating) {
    return (
      <NewCharacter
        key={formId}
        formId={formId}
        since={since}
        close={props.close}
        {...(!dm && you ? { owner: you.memberId } : {})}
        opened={opened}
        onDone={(id, to) => {
          closeForm();
          if (id || to === "back") openPage(id);
        }}
      />
    );
  }

  if (page) {
    return (
      <div ref={root}>
        <CharacterPage character={page} close={props.close} onAddCompanion={() => openForm(pageStore, { kind: "companion", characterId: page.id })} onBlocks={() => openForm(pageStore, { kind: "blocks", characterId: page.id })} onDelete={() => remove(page.id)} />
      </div>
    );
  }

  return (
    <div ref={root} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14 }}>
      {dm || own?.allowed ? (
        <Button variant="primary" size="sm" block onClick={() => openForm(pageStore, { kind: "new" })} data-opener="new-character">
          New character
        </Button>
      ) : null}
      {own && !own.allowed && own.reason === "full" ? <Help>You have as many characters as a player can make. Ask the DM for another.</Help> : null}
      {mine.length === 0 ? (
        // Focusable from script alone: where focus goes when the last character is deleted and there is no New character (characterPage.ts pageBackTo).
        <div data-opener="characters-empty" tabIndex={-1}>
          <Empty>
            {dm
              ? "The party's characters go here. Make one with New character, and pick who plays it."
              : own?.allowed
                ? "Make your character, or wait for the DM to give you one."
                : "Ask the DM for a character."}
          </Empty>
        </div>
      ) : null}
      {mine.map((c) => (
        <CharacterRow key={c.id} character={c} onOpen={() => openPage(c.id)} />
      ))}
      {/* A long rest comes once a day and the list is read every time, so the rest waits below it (docs/design-v1-layout-hierarchy.md M8). */}
      {dm && list.length > 0 ? <PartyLongRest characters={list} /> : null}
      {others.length > 0 ? (
        <Section label="The party">
          <RowList>
            {others.map((c) => (
              <PartyRow key={c.id} character={c} />
            ))}
          </RowList>
        </Section>
      ) : null}
    </div>
  );
}

/** A delete under way, for the focus hand-off once it settles (useDeleteHandOff). */
type Leaving = {
  characterId: string;
  /** What had focus at the press, or null when nothing did and so nothing can be lost. */
  pressed: ReturnType<typeof pressedControl>;
  /** The server's answer, once it came. */
  answer: OpAnswer | null;
};

/**
 * Sends a character's delete, which waits for the server, and looks after
 * focus once it settles, however long an offline delete waits.
 *
 * Taken, the character's page goes with it, and Back's focus goes to the
 * next character's row, else the one before, else New character: the
 * page's header names them (characterPage.ts pageBackTo), since its own row
 * is gone. A delete this device predicts goes at once, and a refusal brings
 * the character and its page back, with focus on its heading as any page
 * that opens.
 *
 * Refused while the page stays, as when the DM shared the character
 * meanwhile, the refusal can take Delete away, and focus goes to the page's
 * heading. It moves only when focus fell to the page, never from where the
 * person put it meanwhile (lib/handFocus.ts handFocusNow).
 */
function useDeleteHandOff(root: RefObject<HTMLDivElement | null>, mine: readonly Character[], onTaken: (characterId: string) => void): (characterId: string) => number | null {
  const actions = useRoomActions();
  const leaving = useRef<Leaving | null>(null);
  const [, settled] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const l = leaving.current;
    if (!l?.answer) return;
    leaving.current = null;
    const gone = !mine.some((c) => c.id === l.characterId);
    // An unknown answer, settled by a reconnect's snapshot, is read from what the view now holds. A refusal of a predicted delete brings the page back.
    if (l.answer === "taken" || (l.answer === "unknown" && gone)) onTaken(l.characterId);
    else if (!gone) handFocusNow(root.current, l.pressed, [CREATURE_HEADING, `[data-opener="character:${l.characterId}"]`]);
  });
  return (characterId) => {
    const l: Leaving = { characterId, pressed: pressedControl(), answer: null };
    const n = actions.dispatch(
      { t: "character.delete", characterId },
      {
        onAnswer: (answer) => {
          l.answer = answer;
          settled();
        },
      },
    );
    if (n !== null) leaving.current = l;
    return n;
  };
}

/**
 * The DM's long rest for the whole party at once (features section 15): one
 * rest per character, sent as one gesture so one undo takes them all back.
 * A character at 0 HP cannot start a rest (shared/rules/rest.ts) and is
 * left as it is.
 */
function PartyLongRest(props: { characters: Character[] }) {
  const actions = useRoomActions();
  const [asking, setAsking] = useState(false);
  const resting = props.characters.filter((c) => c.actor.life === "alive" && c.actor.hp.cur >= 1);
  const left = props.characters.length - resting.length;
  const back = partyRestBackText(resting);
  if (!asking) {
    return (
      <Button size="sm" disabled={resting.length === 0} onClick={() => setAsking(true)}>
        Long Rest for the party
      </Button>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.md,
        background: theme.color.surfaceRaised,
      }}
    >
      <Help>
        {resting.length === 1 ? "1 character gets" : `${resting.length} characters get`} all HP back, lose Temporary HP and one Exhaustion level.
        {back ? ` ${back}` : ""}
        {left > 0 ? ` ${left === 1 ? "1 character at 0 HP stays" : `${left} characters at 0 HP stay`} as they are.` : ""}
      </Help>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Button
          variant="primary"
          size="sm"
          style={{ flex: 1 }}
          onClick={() => {
            dispatchGesture(actions, resting.map((c) => ({ t: "actor.rest", target: { characterId: c.id }, kind: "long" })));
            setAsking(false);
          }}
        >
          Finish the Long Rest
        </Button>
        <Button size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A character's disk in the panel: its portrait, or its initials as the board and the tracker draw them (lib/tokenView.ts). */
export function Portrait(props: { character: Pick<Character, "name" | "defaultImage">; size: number }) {
  const { character, size } = props;
  return <ImagePreview image={character.defaultImage} shape="circle" aspect={1} width={size} ring={theme.color.ally} initials={initials(character.name)} />;
}

/** A character's row: it opens the character's page, so it ends in a chevron right. */
function CharacterRow(props: { character: Character; onOpen(): void }) {
  const { character } = props;
  const members = useRoomView((s) => s.view?.members);
  const role = useRoomView((s) => s.you?.role);
  const hp = hpDisplay({ actor: character.actor, hpVisibility: undefined, fullAccess: true });
  const players = (character.ownerIds ?? []).map((id) => members?.[id]?.name).filter(Boolean).join(", ");
  return (
    <Row
      onClick={props.onOpen}
      opener={`character:${character.id}`}
      leading={<Portrait character={character} size={32} />}
      title={character.name}
      detail={[hpText(hp) ? `HP ${hpText(hp)}` : null, players ? `played by ${players}` : role === "dm" ? "no player yet" : null].filter(Boolean).join(" · ")}
      trailing={<Icon name="chevronRight" style={{ color: theme.color.textMuted }} />}
    />
  );
}


/** Another player's character, as far as this player's projection shows it. */
function PartyRow(props: { character: Character }) {
  const { character } = props;
  const hp = hpDisplay({ actor: character.actor, hpVisibility: undefined, fullAccess: false });
  const effects = character.actor.effects ?? [];
  return (
    <Row
      leading={<Portrait character={character} size={32} />}
      title={character.name}
      detail={hpText(hp) || undefined}
      trailing={
        effects.length > 0 ? (
          // Wraps under itself past five badges, so a long list of conditions never squeezes the name to nothing.
          <span style={{ display: "flex", flexWrap: "wrap", gap: theme.space(0.5), justifyContent: "flex-end", maxWidth: theme.space(30) }}>
            {effects.map((e) => (
              <EffectIcon key={e.id} effect={e} size={20} />
            ))}
          </span>
        ) : undefined
      }
    />
  );
}

type NewCharacterDraft = { name: string; owners: string[]; size: CreatureSize; hpMax: number; ac: number; walk: number; initBonus: number; pp: number; image: ImageRef | null };

/**
 * The quick entry for a new PC: enough for the table, and the player fills
 * in the rest of the page. The DM picks who plays it. A player making their
 * own (`owner`) plays it alone, and "Create and place" puts it straight on
 * the map they are looking at. A subpage of the panel, "New character" with
 * "Back to Characters", and Cancel at its foot beside its buttons.
 */
function NewCharacter(props: { formId: string; since: number; onDone(id: string | null, to: LeaveFor): void; close: PanelClose; owner?: string; opened: number }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const view = useRoomView((s) => s.view);
  const members = useRoomView((s) => s.view?.members);
  const players = Object.values(members ?? {}).filter((m): m is Member => !!m && m.kind === "player");
  const { initial, start } = useKeptDraft<NewCharacterDraft>(props.formId, () => ({
    name: "",
    owners: props.owner ? [props.owner] : [],
    size: "medium",
    hpMax: 10,
    ac: 12,
    walk: 30,
    initBonus: 0,
    pp: 10,
    image: null,
  }));
  const [name, setName] = useState(initial.name);
  const [owners, setOwners] = useState<string[]>(initial.owners);
  const [size, setSize] = useState<CreatureSize>(initial.size);
  const [hpMax, setHpMax] = useState(initial.hpMax);
  const [ac, setAc] = useState(initial.ac);
  const [walk, setWalk] = useState(initial.walk);
  const [initBonus, setInitBonus] = useState(initial.initBonus);
  const [pp, setPp] = useState(initial.pp);
  const [image, setImage] = useState<ImageRef | null>(initial.image);
  const [error, setError] = useState<string | null>(null);
  const draft: NewCharacterDraft = { name, owners, size, hpMax, ac, walk, initBonus, pp, image };
  const { typed, pending } = usePendingNumbers(draft);
  // Only Create sends the form, so a sheet's swipe springs back once anything in it changed (docs/design-v1-sheet-swipe.md 4.5), a number still being typed too.
  useUnsavedSince(typed);
  useKeepDraft(props.formId, typed, start);
  const leave = useLeaveForm(props.formId, typed, JSON.stringify(typed) !== start, (to) => props.onDone(null, to), props.opened, props.since);
  usePanelHeader({ title: "New character", parent: "Characters", id: "new-character", onBack: leave.press, armed: leave.asking ? DISCARD : null, backTo: ["new-character"] });

  const create = (placeAfter: boolean) => {
    if (!name.trim()) {
      setError("Give the character a name.");
      return;
    }
    const id = actions.newId();
    const character = newCharacter({
      id,
      name: name.trim(),
      ownerIds: owners,
      size,
      hpMax,
      ac,
      walk,
      initBonus,
      passivePerception: pp,
      ...(image ? { defaultImage: image } : {}),
    });
    if (actions.dispatch({ t: "character.create", character }) === null) return;
    if (placeAfter && props.owner) {
      const scene = view?.meta.playerSceneId ? view.scenes[view.meta.playerSceneId] : undefined;
      // The view already holds the new character, as the op is applied at once on this device.
      const latest = view && scene ? { ...view, characters: { ...view.characters, [id]: { ...character, rev: 0 } } } : null;
      const token = latest && scene ? myToken(scope, { view: latest, scene, character, memberId: props.owner, id: actions.newId() }) : null;
      if (token && actions.dispatch({ t: "token.create", token }) !== null) ui.select(token.id, { opens: true });
      props.close();
    } else if (placeAfter) {
      setPending(scope, { kind: "character", characterId: id, name: character.name });
      ui.setTool(PLACE_TOOL_ID);
      props.close({ placing: true });
    }
    props.onDone(id, "back");
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <ImageField value={image ?? undefined} onChange={setImage} shape="circle" aspect={1} canEdit ring={theme.color.ally} />
      <FieldRow label="Name" fill>
        <Input aria-label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} error={error !== null} style={{ flex: 1 }} />
      </FieldRow>
      <FieldRow label="Size" fill>
        <Select aria-label="Size" value={size} onChange={(e) => setSize(e.target.value as CreatureSize)} style={{ flex: 1, maxWidth: "100%" }}>
          {SIZE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </FieldRow>
      <FieldRow label="Max HP">
        <NumberField label="Max HP" value={hpMax} min={1} max={100_000} onCommit={(n) => n !== null && setHpMax(n)} onPending={pending("hpMax")} />
      </FieldRow>
      <FieldRow label="Armor Class">
        <NumberField label="Armor Class" value={ac} min={0} max={100} onCommit={(n) => n !== null && setAc(n)} onPending={pending("ac")} />
      </FieldRow>
      <FieldRow label="Speed">
        <NumberField label="Speed" value={walk} min={0} max={1000} onCommit={(n) => n !== null && setWalk(n)} onPending={pending("walk")} />
        <span style={{ color: theme.color.textMuted }}>ft</span>
      </FieldRow>
      <FieldRow label="Initiative bonus">
        <NumberField label="Initiative bonus" value={initBonus} min={-20} max={40} onCommit={(n) => n !== null && setInitBonus(n)} onPending={pending("initBonus")} />
      </FieldRow>
      <FieldRow label="Passive Perception">
        <NumberField label="Passive Perception" value={pp} min={0} max={60} onCommit={(n) => n !== null && setPp(n)} onPending={pending("pp")} />
      </FieldRow>
      {props.owner ? (
        <Help>You play this character. The DM can still change it.</Help>
      ) : (
        <Section label="Played by">
          {players.length === 0 ? <Help>No players have joined yet. You can pick one later.</Help> : null}
          <div>
            {players.map((m) => (
              <Checkbox
                key={m.id}
                checked={owners.includes(m.id)}
                onChange={(on) => setOwners((o) => (on ? [...o, m.id] : o.filter((id) => id !== m.id)))}
                label={m.name}
              />
            ))}
          </div>
        </Section>
      )}
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button variant="primary" size="sm" style={{ flex: "1 1 auto" }} onClick={() => create(true)}>
          Create and place
        </Button>
        <Button size="sm" style={{ flex: "1 1 auto" }} onClick={() => create(false)}>
          Create
        </Button>
        <Button size="sm" style={{ flex: "1 1 auto" }} onClick={leave.press}>
          {leave.asking ? DISCARD : "Cancel"}
        </Button>
      </div>
    </div>
  );
}
