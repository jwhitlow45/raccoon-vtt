import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useStore } from "zustand";
import type { Character, CompanionTurn, CreatureSize, Token } from "#shared/model.ts";
import { playersToken } from "#shared/project.ts";
import { SIX_SIZES } from "#shared/rules/resize.ts";
import type { ClientOp, TokenPatch } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Spinner } from "../../components/Loading.tsx";
import { GROUP_BOX, GROUP_FOLD, Group, Help } from "../../components/Panel.tsx";
import { Row, RowList } from "../../components/Row.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { Tag } from "../../components/Tag.tsx";
import { SOURCE_TAG_PX } from "../monsters/MonsterList.tsx";
import { layoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { panAnchor, requestPan } from "../encounter/pan.ts";
import { useSend } from "../encounter/hooks.ts";
import { ImageField } from "../images/ImageField.tsx";
import { ImagePreview } from "../images/IconDisk.tsx";
import { currentStageCamera } from "../scenes/stageCamera.ts";
import { displayName, footprint } from "../../lib/scene.ts";
import { handFocusOn } from "../../lib/handFocus.ts";
import { useUnsavedInput, useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { initials } from "../../lib/tokenView.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { usePanelHeader } from "../panels.ts";
import type { TokenAccess } from "./access.ts";
import { characterPageSlot, DISCARD, patchForm, useKeepDraft, useKeptDraft, useLeaveForm, usePendingNumbers, type LeaveFor } from "./characterPage.ts";
import { ChooseBlockDialog } from "./CompanionBlocks.tsx";
import { characterBlocks, fromTheBlock, srdTitle, whose, type PickerRow } from "./companionBlocks.ts";
import {
  NEW_COMPANION,
  blockHpHelp,
  companionInput,
  companionWhat,
  companionsOf,
  dmPlacement,
  draftError,
  draftWith,
  joinFightOp,
  lateCompanionText,
  linkPatch,
  makeCompanionPatch,
  playerPlacement,
  turnChoices,
  turnLabel,
  withBlock,
  type ChosenBlock,
  type CompanionDraft,
  type CompanionWhat,
} from "./companions.ts";
import { SIZE_WORDS } from "./resize.ts";
import { FieldRow, NumberField, Select } from "./ui.tsx";

/**
 * Companions in the interface (docs/design-v1-combat-flow.md 3.6.3, 3.6.9
 * and 3.7.5): the list and "Add a companion" in a character's page, the
 * form it opens as a subpage of the Characters panel, the Companion section of a
 * companion's token panel, and the DM's "Make a companion" in Token
 * settings. Every change of what a companion is waits for the server
 * (shared/reads.ts), so each control shows busy until it answers.
 */

// A companion's size is one of the six, never Custom, which only the DM sets on a token.
const SIZE_OPTIONS = SIX_SIZES.map((value) => ({ value, label: SIZE_WORDS[value] }));

const WHAT_OPTIONS: { value: CompanionWhat; label: string }[] = [
  { value: "creature", label: "A creature" },
  { value: "effect", label: "An effect" },
];

/** A companion's picture: its token's image, or its initials, square for an effect as the map draws it. */
function CompanionPortrait(props: { token: Token; size: number }) {
  const fp = footprint(props.token);
  return (
    <ImagePreview
      image={props.token.image}
      shape={props.token.kind === "object" ? "square" : "circle"}
      aspect={fp.w / fp.h}
      width={props.size}
      ring={theme.color.ally}
      initials={initials(displayName(props.token))}
    />
  );
}

/**
 * The Companions group of a character's page, after Combat: in play a
 * player opens the page more often for companions than to edit stats
 * (docs/design-v1-combat-flow.md 3.7.5). It lists the companions on the
 * scene this device holds, each a button that shows it on the map with
 * its bar, as a party bar tap does. Folded, it names them.
 */
export function CharacterCompanions(props: { character: Character; canAdd: boolean; onAdd(): void; onBlocks?(): void; close(): void; group: { open: boolean; onToggle(): void } }) {
  const tokens = useRoomView((s) => s.view?.tokens);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  const monsters = useRoomView((s) => s.view?.monsters);
  const ui = useRoomUi();
  const scope = useRoomScope();
  const list = tokens ? companionsOf({ tokens }, props.character.id) : [];
  const kept = characterBlocks({ companionBlocks: blocks ?? {} }, props.character.id).length;
  if (list.length === 0 && !props.canAdd) return null;
  // Each companion's block, before its turn (docs/design-v1-companion-stat-blocks.md 6.4). An effect has none to name.
  const blockName = (t: Token): string | null => {
    if (t.kind === "object" || !("inline" in t.actor)) return null;
    const a = t.actor.inline;
    if (a.blockId !== undefined) return blocks?.[a.blockId]?.name ?? "Stat block deleted";
    if (a.monsterId !== undefined) return monsters?.[a.monsterId]?.name ?? "Stat block deleted";
    return a.srdId !== undefined ? srdTitle(a.srdId) : null;
  };
  const show = (token: Token) => {
    ui.tap(token.id);
    props.close();
    const fp = footprint(token);
    requestPan(scope, {
      sceneId: token.sceneId,
      x: token.x + fp.w / 2,
      y: token.y + fp.h / 2,
      anchor: panAnchor(layoutSize(window, uiScale()), theme.layout.wideMinWidth, false),
    });
  };
  return (
    <Group label="Companions" {...props.group} summary={list.length > 0 ? list.map(displayName).join(", ") : "None yet"}>
      {list.length > 0 ? (
        <RowList label={`${props.character.name}'s companions`}>
          {list.map((t) => (
            <Row
              key={t.id}
              leading={<CompanionPortrait token={t} size={28} />}
              title={displayName(t)}
              detail={t.companion ? [blockName(t), turnLabel(props.character.name, t.companion.turn)].filter(Boolean).join(" · ") : undefined}
              label={`${displayName(t)}. Show it on the map with its actions`}
              onClick={() => show(t)}
              trailing={<Icon name="chevronRight" style={{ color: theme.color.textMuted }} />}
            />
          ))}
        </RowList>
      ) : null}
      {props.canAdd ? (
        // Side by side where the width holds both, else one under the other.
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          <Button size="sm" onClick={props.onAdd} data-opener={`companion:${props.character.id}`}>
            Add a companion
          </Button>
          {props.onBlocks ? (
            <Button size="sm" onClick={props.onBlocks} data-opener={`blocks:${props.character.id}`}>
              {`Stat blocks (${kept})`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Group>
  );
}

/**
 * The form a character's "Add a companion" opens, a subpage of the
 * Characters panel as New character is: "Add a companion for Bree" with
 * "Back to Bree" in the header, and Cancel at its foot beside Add and place
 * (docs/design-v1-look-pass.md 3.1). A player's companion goes only next to
 * the character's token on the players' scene, at the first free spot
 * within 5 ft with a clear line, which the server checks again. The button
 * says why when there is none. The DM's goes on the scene in view, beside
 * the character's token when it stands there, else in the middle of the
 * view. It is busy until the server answers, and a refusal keeps the form
 * open with the reason.
 */
export function CompanionForm(props: {
  /** This opening of the form, which a remount keeps (characterPage.ts PanelForm). */
  formId: string;
  /** The count of outside opens when it opened (useLeaveForm). */
  since: number;
  character: Character;
  /** Whether the panel holding the form is on screen (PanelProps.shown). */
  shown: boolean;
  close(): void;
  /** `back` once added, or left by Back or Cancel, and `page` for a page opened from outside the panel (characterPage.ts). */
  onDone(to: LeaveFor): void;
  /** The Characters panel's count of pages opened from outside it (characterPage.ts openCharacterPage). */
  opened: number;
}) {
  const { character } = props;
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const dm = useRoomView((s) => s.you?.role === "dm");
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const pageStore = useScoped(characterPageSlot);
  const { formId } = props;
  const { initial, start } = useKeptDraft<CompanionDraft>(formId, () => NEW_COMPANION);
  const [draft, setDraft] = useState<CompanionDraft>(initial);
  const { typed, pending } = usePendingNumbers(draft, draftWith);
  // Only Add sends it, so a sheet's swipe springs back once anything in it changed (docs/design-v1-sheet-swipe.md 4.5), a number still being typed too.
  useUnsavedSince(typed);
  useKeepDraft(formId, typed, start);
  const [error, setError] = useState<string | null>(null);
  // Kept with the form instance, so a form a remount opened again stays busy until its Add is answered.
  const waiting = useStore(pageStore, (s) => s.form?.id === formId && s.form.kind === "companion" && s.form.sending === true);
  const setWaiting = (on: boolean) =>
    patchForm(pageStore, formId, (form) => {
      if (form.kind !== "companion") return form;
      if (on) return { ...form, sending: true };
      const { sending: _sent, ...rest } = form;
      return rest;
    });
  const [choosing, setChoosing] = useState(false);
  const [blockGone, setBlockGone] = useState(false);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  const changeRef = useRef<HTMLButtonElement>(null);
  const focusChange = useRef(false);
  // Typed changes ask first, but not once Add sent them: then leaving throws nothing away.
  const leave = useLeaveForm(formId, typed, !waiting && JSON.stringify(typed) !== start, props.onDone, props.opened, props.since);
  usePanelHeader({
    title: `Add a companion for ${character.name}`,
    parent: character.name,
    id: `companion:${character.id}`,
    onBack: leave.press,
    armed: leave.asking ? DISCARD : null,
    backTo: [`companion:${character.id}`],
  });
  /*
   * An answer moves the screen only while this form is still open and in
   * sight. After Cancel, or with another panel opened since, a late one may
   * not select the new token or close what the user has moved on to, and
   * Cancel cannot take back an op the server may already hold.
   */
  const mounted = useRef(true);
  const inSight = useRef(props.shown);
  inSight.current = props.shown;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = (patch: Parameters<typeof draftWith>[1]) => {
    setDraft((d) => draftWith(d, patch));
    setError(null);
  };
  /*
   * A chosen block of the character's that leaves the view, deleted by a
   * co-owner or the DM, is chosen no more, and the numbers it filled stay
   * (docs/design-v1-companion-stat-blocks.md 6.3).
   */
  const chosenBlockId = draft.block && "blockId" in draft.block.link ? draft.block.link.blockId : undefined;
  const chosenLeft = chosenBlockId !== undefined && blocks !== undefined && blocks[chosenBlockId] === undefined;
  useEffect(() => {
    if (!chosenLeft) return;
    setDraft((d) => withBlock(d, null));
    setBlockGone(true);
  }, [chosenLeft]);
  // Choosing hands focus back to the field's Change, which takes Choose's place.
  useEffect(() => {
    if (!focusChange.current || choosing) return;
    focusChange.current = false;
    changeRef.current?.focus();
  });
  const choose = (row: PickerRow) => {
    const chosen: ChosenBlock = { link: row.link, view: row.view, source: row.source, ...(row.picture ? { picture: row.picture } : {}) };
    setDraft((d) => withBlock(d, chosen));
    setBlockGone(false);
    setError(null);
    focusChange.current = true;
    setChoosing(false);
  };
  const name = character.name;
  const live = currentStageCamera(scope);
  const scene = sceneId ? view?.scenes[sceneId] : undefined;
  const center = live
    ? { x: (live.viewport.width / 2 - live.camera.x) / live.camera.scale, y: (live.viewport.height / 2 - live.camera.y) / live.camera.scale }
    : { x: (scene?.bounds.w ?? 0) / 2, y: (scene?.bounds.h ?? 0) / 2 };
  const placement = !view ? null : dm ? dmPlacement(view, character, { size: draft.size }, { sceneId, center }) : playerPlacement(view, character, { size: draft.size });
  const choices = turnChoices(name, draft.what);
  const chosen = choices.find((c) => c.value === draft.turn) ?? choices[0]!;
  const besideHere = dm && sceneId !== null && Object.values(view?.tokens ?? {}).some((t) => t?.sceneId === sceneId && "ref" in t.actor && t.actor.ref === character.id);
  const where = !placement?.ok ? placement?.reason : dm && !besideHere ? "Goes in the middle of your view." : `Goes next to ${name} on the map.`;

  const add = () => {
    const problem = draftError(draft);
    if (problem) {
      setError(problem);
      return;
    }
    if (!placement?.ok || waiting) return;
    const id = actions.newId();
    const op: ClientOp = { t: "token.create", token: companionInput(draft, { id, sceneId: placement.sceneId, x: placement.x, y: placement.y, elevation: placement.elevation }, character) };
    const sentName = op.token.name;
    const onAnswer = (answer: OpAnswer, refusal?: OpRefusal) => {
      if (!mounted.current || !inSight.current) {
        const text = lateCompanionText(sentName, answer, refusal);
        if (text) ui.notify(text, "error");
        // A remount opened this form instance again, busy (characterPage.ts): once added it goes, so the companion is never added twice, else it takes Add again. An instance closed or replaced meanwhile is left alone.
        if (!mounted.current) {
          if (answer === "taken") patchForm(pageStore, formId, () => null);
          else setWaiting(false);
          return;
        }
        // Still open out of sight: done once added, else showing why for when the user comes back.
        setWaiting(false);
        if (answer === "taken") props.onDone("back");
        else setError(answer === "refused" && refusal?.message ? capitalized(refusal.message) : "It may not have been added. Check the map before trying again.");
        return;
      }
      setWaiting(false);
      if (answer === "taken") {
        // Selected with its bar open on the map, as a tap on it does, and the sheet gets out of the way so the player can drag it on.
        ui.tap(id);
        props.close();
        props.onDone("back");
      } else if (answer === "refused") setError(refusal?.message ? capitalized(refusal.message) : "The server refused it.");
      else setError("It may not have been added. Check the map before trying again.");
    };
    // An own-turn companion made mid-fight joins it in the same undo step. Its row's answer stays quiet: refused, as when the fight ended meanwhile, the companion waits in Join the fight.
    const join = view ? joinFightOp(view, op.token, actions.newId()) : null;
    const together = join ? { group: actions.newId() } : null;
    if (actions.dispatch(op, { onAnswer, quiet: true, ...together }) !== null) {
      setWaiting(true);
      if (join) actions.dispatch(join, { quiet: true, ...together });
    }
  };

  return (
    // One column no wider than the pane, so a long turn label shortens its Select rather than widening the form, and a character's long unbroken name wraps in the lines that name it.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
      <FieldRow label="Name">
        <Input aria-label="Name" value={draft.name} maxLength={80} error={error !== null && !draft.name.trim()} onChange={(e) => set({ name: e.target.value })} style={{ flex: 1 }} />
      </FieldRow>
      <FieldRow label="It is">
        <Segmented<CompanionWhat> label="What it is" value={draft.what} options={WHAT_OPTIONS} onChange={(what) => set({ what })} />
      </FieldRow>
      {draft.what === "creature" ? (
        <BlockField
          character={character}
          chosen={draft.block}
          gone={blockGone}
          changeRef={changeRef}
          onChoose={() => setChoosing(true)}
          onRemove={() => {
            setDraft((d) => withBlock(d, null));
            setBlockGone(false);
          }}
        />
      ) : null}
      <TurnField>
        <Select<CompanionTurn> label="Turn" value={chosen.value} options={choices} onChange={(turn) => set({ turn })} />
      </TurnField>
      <Help>{chosen.help}</Help>
      <FieldRow label="Size">
        <Select<CreatureSize> label="Size" value={draft.size} options={SIZE_OPTIONS} onChange={(size) => set({ size })} />
      </FieldRow>
      {draft.what === "creature" ? (
        <>
          <FieldRow label="HP">
            <NumberField label="HP" value={draft.hp ?? undefined} min={1} max={100_000} nullable onCommit={(hp) => set({ hp })} onPending={pending("hp")} />
          </FieldRow>
          {draft.block ? <Help>{blockHpHelp(draft.block.view)}</Help> : null}
          <FieldRow label="AC" hint="Optional">
            <NumberField label="AC" value={draft.ac ?? undefined} min={0} max={100} nullable onCommit={(ac) => set({ ac })} onPending={pending("ac")} />
          </FieldRow>
        </>
      ) : null}
      <ImageField
        value={draft.image ?? undefined}
        onChange={(image) => set({ image })}
        shape={draft.what === "effect" ? "square" : "circle"}
        aspect={1}
        canEdit
        ring={theme.color.ally}
        initials={initials(draft.name || "?")}
      />
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button variant="primary" size="sm" busy={waiting} disabled={!placement?.ok} aria-describedby="companion-where" onClick={add} style={{ flex: "1 1 auto" }}>
          {waiting ? "Adding…" : "Add and place"}
        </Button>
        <Button size="sm" onClick={leave.press} style={{ flex: "1 1 auto" }}>
          {leave.asking ? DISCARD : "Cancel"}
        </Button>
      </div>
      {where ? <Help id="companion-where">{where}</Help> : null}
      {choosing ? <ChooseBlockDialog character={character} name={draft.name} onChoose={choose} onClose={() => setChoosing(false)} /> : null}
    </div>
  );
}

/**
 * The add form's Stat block field (6.3), its label above it as Turn's is,
 * so a long name shortens rather than widening the form: "Choose a stat
 * block" with none, else its name, its source, Change, Remove and what the
 * companion takes from it besides the form's own fields.
 */
function BlockField(props: {
  character: Character;
  chosen: ChosenBlock | null;
  gone: boolean;
  changeRef: RefObject<HTMLButtonElement | null>;
  onChoose(): void;
  onRemove(): void;
}) {
  const { chosen } = props;
  return (
    // A character's name of any length, unbroken too, wraps in the help line rather than run out of the form.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1), fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
      <span>Stat block</span>
      {chosen ? (
        <>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
            <strong style={{ minWidth: 0, overflowWrap: "anywhere" }}>{chosen.view.name}</strong>
            <Tag tone="muted" cut={SOURCE_TAG_PX}>
              {chosen.source === "srd" ? "SRD" : whose(props.character.name)}
            </Tag>
            <span style={{ flex: 1 }} />
            <Button ref={props.changeRef} size="sm" onClick={props.onChoose}>
              Change
            </Button>
            <Button size="sm" onClick={props.onRemove}>
              Remove
            </Button>
          </div>
          <Help style={{ overflowWrap: "anywhere" }}>{fromTheBlock(chosen.view)}</Help>
        </>
      ) : (
        <>
          <div style={{ display: "flex" }}>
            <Button size="sm" onClick={props.onChoose}>
              Choose a stat block
            </Button>
          </div>
          <Help>{props.gone ? "The chosen stat block was deleted." : `Optional: an SRD creature, one of ${whose(props.character.name)}, or one you paste.`}</Help>
        </>
      )}
    </div>
  );
}

/**
 * The Turn field, its Select under its label at the pane's full width: its
 * choices name the character twice ("On Bree's turn, listed under Bree"),
 * which beside the label would cut off on a phone.
 */
function TurnField(props: { children: ReactNode }) {
  return (
    <label style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1), fontSize: theme.font.body14, color: theme.color.text }}>
      Turn
      {props.children}
    </label>
  );
}

/** A refusal's words as a line of the form. */
function capitalized(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * The Companion section of a companion's token panel, for the DM and its
 * owners (3.6.9): whose it is, what it is and its turn. A player's change
 * of what it is or its turn waits for the server, busy until it answers.
 * Making it an effect waits until it acts on its character's turn, since
 * an effect takes no turn of its own.
 */
export function CompanionSection(props: {
  token: Token;
  access: TokenAccess;
  /** The token panel's fold for this group, which names its character while folded (docs/design-v1-token-panel.md 3.5). */
  group?: { open: boolean; onToggle(): void };
}) {
  const { token, access } = props;
  const companion = token.companion;
  const characters = useRoomView((s) => s.view?.characters);
  const blockId = "inline" in token.actor ? token.actor.inline.blockId : undefined;
  const stored = useRoomView((s) => (blockId !== undefined ? s.view?.companionBlocks[blockId] !== undefined : false));
  const relink = useSend();
  const kind = useSend();
  const detach = useSend();
  if (!companion || !access.companion) return null;
  const owner = characters?.[companion.of];
  const name = owner?.name ?? "its character";
  const what = companionWhat(token.kind);
  const choices = turnChoices(name, what);
  const chosen = choices.find((c) => c.value === companion.turn) ?? choices[0]!;
  const send = (patch: TokenPatch) => relink.send({ t: "token.update", tokenId: token.id, patch });
  const list = Object.values(characters ?? {})
    .filter((c): c is Character => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
  // A stored block is its character's, so giving the companion away or letting it go leaves the block behind (docs/design-v1-companion-stat-blocks.md 5.5).
  const staysLine = stored ? <Help style={{ overflowWrap: "anywhere" }}>{`Its stat block is ${name}’s and stays with ${name}.`}</Help> : null;
  return (
    // A group as Owners beside it is, which names its character while folded as Owners names its players.
    <Group label="Companion" open={props.group?.open} onToggle={props.group?.onToggle} summary={name}>
      {access.dm ? (
        <>
          <FieldRow label="Belongs to">
            <Select<string>
              label="Belongs to"
              value={companion.of}
              disabled={relink.waiting}
              options={list.map((c) => ({ value: c.id, label: c.name }))}
              onChange={(of) => send(linkPatch(companion, { of }))}
            />
          </FieldRow>
          {staysLine}
        </>
      ) : (
        <Help>
          Belongs to {name}. Whoever plays {name} controls it.
        </Help>
      )}
      <FieldRow label="It is">
        <Segmented<CompanionWhat>
          label="What it is"
          value={what}
          disabled={kind.waiting}
          options={WHAT_OPTIONS.map((o) => (o.value === "effect" && companion.turn === "own" ? { ...o, disabled: true } : o))}
          onChange={(next) => next !== what && kind.send({ t: "token.update", tokenId: token.id, patch: { kind: next === "effect" ? "object" : "npc" } })}
        />
      </FieldRow>
      {companion.turn === "own" ? <Help>Choose one of {name}'s turns first.</Help> : null}
      <TurnField>
        <Select<CompanionTurn> label="Turn" value={chosen.value} disabled={relink.waiting} options={choices} onChange={(turn) => send(linkPatch(companion, { turn }))} />
      </TurnField>
      <Help>{chosen.help}</Help>
      {relink.waiting || kind.waiting ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), color: theme.color.textMuted, fontSize: theme.font.small }}>
          <Spinner label="Saving" /> Saving…
        </span>
      ) : null}
      {access.dm ? (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
          <Button size="sm" busy={detach.waiting} onClick={() => detach.send({ t: "token.update", tokenId: token.id, patch: { companion: null } })}>
            Stop being a companion
          </Button>
          {staysLine}
        </div>
      ) : null}
    </Group>
  );
}

/** The empty choice "Belongs to" starts at, which no character id can be. */
const NO_CHARACTER = "";

/**
 * The DM's "Make a companion" in Token settings, on any token that is not
 * a PC, has stats of its own and is not yet a companion (3.6.9): it opens
 * whose it is and its turn in place, with no character chosen and the turn
 * listed under its character (docs/design-v1-token-panel.md 3.8), and
 * sends nothing until its own button, which waits for a character. Cancel
 * starts the form again from there. The one update also gives a hostile
 * token the ally ring.
 */
export function MakeCompanion(props: { token: Token }) {
  const { token } = props;
  const characters = useRoomView((s) => s.view?.characters);
  const [open, setOpen] = useState(false);
  const list = Object.values(characters ?? {})
    .filter((c): c is Character => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
  const [of, setOf] = useState<string>(NO_CHARACTER);
  const [turn, setTurn] = useState<CompanionTurn>("shared");
  const make = useSend();
  /*
   * The opener and the form take each other's place, so focus moves with
   * them: into the form's first field on opening, back to the opener on
   * Cancel. Done, the token is a companion and all of this goes, so focus
   * moves to its section's label.
   */
  const opener = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLDivElement>(null);
  const focusOpener = useRef(false);
  useEffect(() => {
    if (open) (form.current?.querySelector<HTMLElement>("select") ?? form.current)?.focus();
    else if (focusOpener.current) opener.current?.focus();
    focusOpener.current = false;
  }, [open]);
  // A companion has stats of its own, so a token that reads a character's cannot be one.
  const cannot = token.kind === "pc" || token.companion || "ref" in token.actor;
  // Only its button sends the choices, so a sheet's swipe springs back while the form shows them changed (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedInput(open && !cannot && list.length > 0 && !make.waiting && (of !== NO_CHARACTER || turn !== "shared"));
  if (cannot) return null;
  if (!open) {
    return (
      <div style={{ display: "flex" }}>
        <Button ref={opener} size="sm" onClick={() => setOpen(true)}>
          Make a companion
        </Button>
      </div>
    );
  }
  if (list.length === 0) {
    return (
      <div ref={form} tabIndex={-1}>
        <Help>A companion belongs to a character. Make a character first.</Help>
      </div>
    );
  }
  const character = list.find((c) => c.id === of);
  const choices = turnChoices(character?.name ?? "its character", companionWhat(token.kind));
  const chosen = choices.find((c) => c.value === turn) ?? choices[0]!;
  const cancel = () => {
    focusOpener.current = true;
    setOpen(false);
    setOf(NO_CHARACTER);
    setTurn("shared");
  };
  const confirm = () => {
    if (!character) return;
    make.send({ t: "token.update", tokenId: token.id, patch: makeCompanionPatch(token, character.id, chosen.value) });
    // To Token settings' fold, the group the form sits in.
    handFocusOn(form.current?.closest<HTMLElement>(GROUP_BOX), [GROUP_FOLD]);
  };
  return (
    <div ref={form} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <FieldRow label="Belongs to">
        <Select<string>
          label="Belongs to"
          value={character ? character.id : NO_CHARACTER}
          options={[...(character ? [] : [{ value: NO_CHARACTER, label: "Choose a character" }]), ...list.map((c) => ({ value: c.id, label: c.name }))]}
          onChange={setOf}
        />
      </FieldRow>
      <TurnField>
        <Select<CompanionTurn> label="Turn" value={chosen.value} options={choices} onChange={setTurn} />
      </TurnField>
      <Help>{chosen.help}</Help>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Button
          size="sm"
          variant="primary"
          busy={make.waiting}
          disabled={!character}
          onClick={confirm}
        >
          Make a companion
        </Button>
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The Owners section's line for a companion, whose owners are its character's (3.6.9). */
export function CompanionOwners(props: { token: Token }) {
  const characters = useRoomView((s) => s.view?.characters);
  const members = useRoomView((s) => s.view?.members);
  const companion = props.token.companion;
  if (!companion) return null;
  const character = characters?.[companion.of];
  const players = (character?.ownerIds ?? []).map((id) => members?.[id]?.name).filter(Boolean);
  const name = character?.name ?? "its character";
  return (
    <Help>
      Played by whoever plays {name}: {players.length > 0 ? players.join(", ") : "no one yet"}.
    </Help>
  );
}

/**
 * Whether a token's HP follows the party's rule rather than its own
 * setting: a creature companion a player plays (docs/design-v1-combat-flow.md
 * 3.6.5), whose "Players see HP as" reads so in place of the Select.
 */
export function followsPartyHp(view: Parameters<typeof playersToken>[0] | null | undefined, token: Token): boolean {
  return !!view && token.companion !== undefined && token.kind !== "object" && playersToken(view, token);
}
