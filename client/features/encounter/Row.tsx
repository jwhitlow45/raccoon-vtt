import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject } from "react";
import type { Effect, InitEntry, Token } from "#shared/model.ts";
import { playersTypeTotals } from "#shared/permissions.ts";
import { playerPlays, type ProjectedActor } from "#shared/project.ts";
import { hpLess, shownLife } from "#shared/rules/hp.ts";
import { rowCharacter } from "#shared/rules/initiative.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { AcBadge } from "../../components/AcBadge.tsx";
import { Button } from "../../components/Button.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Switch } from "../../components/Switch.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { creatureRolls, srdNeeds } from "../dice/creature.ts";
import { creatureKey, signedText } from "../dice/options.ts";
import { useOptionStore } from "../dice/optionState.ts";
import { presetFor } from "../dice/presets.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useInitiativeChanged, useRollBlocked, useRollOption, useRowResult, useWatchInitiative } from "../dice/useRollOption.ts";
import { ownResultText } from "../dice/useRollToasts.ts";
import { REVIVE_NOTE, ReviveButton, offersRevive } from "../tokens/Revive.tsx";
import { ownsToken } from "../tokens/access.ts";
import { opensStatBlock, statBlockShown, tokenStatBlock } from "../monsters/statBlockLink.ts";
import { displayName } from "../../lib/scene.ts";
import { openStatBlock } from "../tokens/statBlockOpen.ts";
import { usePanelHere } from "../panels.ts";
import { RowRollTools } from "./AutoInitiative.tsx";
import { useSend } from "./hooks.ts";
import { entryActor, entryName, hpView, nestedCompanions, parseInitiative, rollReminder, rowAc, SECRET_ROW, secretUntilItsTurn, valueText, type HpView } from "./logic.ts";
import { Chips, DescribedHp, DescribedItems, Portrait, RollBadge, Spinner } from "./parts.tsx";
import { readiedEffect, rowTarget, type ReactionTarget } from "./ready.ts";
import { ReadyControls } from "./ReadyControls.tsx";

export type RowDrag = {
  /** Pointer handlers for the drag handle. Absent when the row has no tie to reorder. */
  handle?: {
    onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
    onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
    onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
    onPointerCancel(e: ReactPointerEvent<HTMLElement>): void;
  };
  /** Whether the row keeps the handle's slot with no handle in it, lining its name up with tied rows (logic.ts keepsDragSlot). */
  slot: boolean;
  /** Pixels the row is shifted while a drag is in progress. */
  offset: number;
  dragging: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveBy(step: -1 | 1): void;
};

/**
 * One initiative row: picture, name, AC and HP as the viewer may see them,
 * condition chips, roll reminders and the typed value. The DM's
 * controls (hidden, reaction, lair, legendary pips, reminders, tie order,
 * removal) open under the row, at full touch size, instead of crowding it.
 */
export function EntryRow(props: {
  entry: InitEntry;
  active: boolean;
  role: "dm" | "player";
  /** A player's own creature. */
  mine: boolean;
  expanded: boolean;
  /** "Multi-select" is on: a tap picks the creature for the shared HP entry instead of showing it. */
  picking: boolean;
  /** Picked for the shared HP entry. */
  selected: boolean;
  onExpand(): void;
  onShow(): void;
  /** A tap on a companion listed under the row, which does what a row tap does for its token. */
  onShowToken(tokenId: string): void;
  drag: RowDrag | null;
  rowRef: Ref<HTMLLIElement>;
}) {
  const { entry, active, role, mine } = props;
  const dm = role === "dm";
  // With typed totals off a player rolls their initiative and never types it (shared/permissions.ts playersTypeTotals).
  const typeTotals = useRoomView((s) => playersTypeTotals(s.view?.meta.settings ?? {}));
  const name = useRoomView((s) => (s.view ? entryName(s.view, entry) : ""));
  const token = useRoomView((s) => (entry.tokenId !== undefined ? s.view?.tokens[entry.tokenId] : undefined));
  const characterId = entry.characterId ?? (token && "ref" in token.actor ? token.actor.ref : undefined);
  const character = useRoomView((s) => (characterId !== undefined ? s.view?.characters[characterId] : undefined));
  const actor = entryActor(
    { tokens: token ? { [token.id]: token } : {}, characters: character ? { [character.id]: character } : {} },
    entry.tokenId !== undefined ? { tokenId: entry.tokenId } : entry.characterId !== undefined ? { characterId: entry.characterId } : {},
  );
  // A creature with no HP to show has no readout (docs/design-v1-combat-flow.md 3.6.6).
  const hp = hpLess(actor, token) ? NO_HP : hpView(actor);
  // The AC shield, first on the second line, which is the row button's description (docs/design-v1-combat-flow.md 3.3).
  const ac = rowAc(actor, token);
  const lineId = useId();
  // The companions listed under the row, and whose they are (docs/design-v1-combat-flow.md 3.6.7).
  const tokens = useRoomView((s) => s.view?.tokens);
  const companions = useMemo(() => (tokens ? nestedCompanions({ tokens }, entry) : NO_COMPANIONS), [tokens, entry]);
  const rowOwner = useRoomView((s) => {
    const id = s.view ? rowCharacter(s.view, entry) : undefined;
    return id !== undefined ? s.view?.characters[id]?.name : undefined;
  });
  // An own-turn companion's row names whose it is, in the words of the token panel's name block, for every viewer whose copy says so.
  const companionOf = useRoomView((s) => (token?.companion ? s.view?.characters[token.companion.of]?.name : undefined));
  const effects = actor?.effects ?? [];
  // Whoever rolls this creature's initiative sees the reminder: the DM for every row, a player for their own.
  const reminder = dm || mine ? rollReminder(entry, effects) : undefined;
  const legendary = dm ? actor?.legendary : undefined;
  const readied = readiedEffect(effects);
  const secret = useRoomView((s) => dm && s.view !== null && secretUntilItsTurn(s.view, entry));
  // A Ready action's trigger reaches other players only on a creature a player plays (shared/project.ts).
  const playerOwned = useRoomView((s) => {
    if (!s.view) return false;
    if (token && "inline" in token.actor) return playerPlays(s.view, { token });
    return character ? playerPlays(s.view, { character }) : false;
  });
  // An HP-less creature is never drawn dead, whatever it stores (docs/design-v1-combat-flow.md 3.6.6).
  const life = shownLife(actor, token);
  const dead = life === "dead";
  // A companion's players open its block from its row where its bar would (docs/design-v1-companion-stat-blocks.md 6.7).
  const playerBlock = useCompanionBlockOpens(!dm && mine ? token : undefined);
  // A player character's own stat block, or the shape it takes, opens from its row for the DM and its players, on its token (docs/design-v1-pc-stats.md 7.4).
  const pcBlock = (dm || mine) && token !== undefined && "ref" in token.actor && (character?.stats !== undefined || character?.actor.srdId !== undefined);
  const drag = props.drag;
  const slotted = handleSlot(dm, drag);
  // Whoever rolls this creature's initiative rolls it from the row: a player their own, the DM a creature no player plays (docs/design-v1-roll-options.md 4.5).
  const creature = useMemo(() => rowCreature(entry.tokenId, entry.characterId), [entry.tokenId, entry.characterId]);
  const rolls = creature !== null && (mine || (dm && !playerOwned));
  const [rollAt, setRollAt] = useState<RollAt | null>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const linePx = useWidth(lineRef, rolls);
  const rollButton = rolls && creature ? <InitiativeRoll entry={entry} creature={creature} name={name} onRolled={setRollAt} /> : null;
  // Beside the box only while the row has no value: a set row's Roll waits in its options as "Roll again", so a stray tap mid-fight never reorders it (W7B-P-6).
  const rollBeside = entry.value === null && rollFitsBeside(linePx, slotted);

  const rowStyle: CSSProperties = {
    position: "relative",
    listStyle: "none",
    borderRadius: theme.radius.md,
    background: active ? theme.color.turnTint : drag?.dragging ? theme.color.surfaceRaised : "transparent",
    border: `${theme.line.border}px solid ${props.selected ? theme.color.accent : active ? theme.color.accentSoft : "transparent"}`,
    transform: drag && drag.offset !== 0 ? `translateY(${drag.offset}px)` : undefined,
    transition: drag?.dragging ? "none" : "transform 120ms",
    zIndex: drag?.dragging ? 2 : undefined,
    boxShadow: drag?.dragging ? theme.shadow.pane : undefined,
  };

  return (
    // A standard row, with no companions and its options closed, is what the round header leaves room for (3.1).
    <li
      ref={props.rowRef}
      style={rowStyle}
      aria-current={active ? "step" : undefined}
      data-entry-row=""
      data-standard-row={companions.length === 0 && !props.expanded ? "" : undefined}
    >
      <div ref={lineRef} style={{ display: "flex", alignItems: "center", gap: theme.space(1), minHeight: 56 }}>
        {slotted ? <DragHandle drag={drag} name={name} /> : null}
        <button
          type="button"
          data-row-button=""
          onClick={props.onShow}
          aria-label={`${name}${active ? ", acting now" : ""}. ${props.picking ? "Pick for the shared HP entry" : "Show it on the map with its actions"}`}
          aria-describedby={lineId}
          aria-pressed={props.picking ? props.selected : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: theme.space(2),
            minHeight: theme.touch,
            padding: `${theme.space(1)}px ${slotted ? 0 : theme.space(2)}px`,
            background: "transparent",
            border: "none",
            color: theme.color.text,
            fontFamily: theme.font.body,
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <Portrait entry={entry} size={36} ring={active ? theme.color.accentSoft : undefined} dim={dead} />
          <span style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(0.5) }}>
            <span
              data-row-name=""
              style={{
                fontSize: theme.font.input,
                fontWeight: active ? theme.weight.bold : theme.weight.strong,
                color: active ? theme.color.accentSoft : dead ? theme.color.textMuted : theme.color.text,
                textDecoration: dead ? "line-through" : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
            <span id={lineId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), fontSize: theme.font.small, color: theme.color.textMuted }}>
              <DescribedItems
                items={[
                  ac !== null ? <AcBadge ac={ac} size="sm" /> : null,
                  hp.kind !== "none" ? <DescribedHp hp={hp} /> : null,
                  reminder ? <RollBadge kind={reminder} /> : null,
                  dm && entry.hidden ? (
                    <Tag tone="muted" dense>
                      Hidden
                    </Tag>
                  ) : null,
                  secret ? (
                    <Tag tone="muted" dense title={SECRET_ROW.help}>
                      {SECRET_ROW.label}
                    </Tag>
                  ) : null,
                  readied ? (
                    <Tag tone="turn" dense>
                      Readied
                    </Tag>
                  ) : null,
                  entry.reactionUsed ? (
                    <Tag tone="muted" dense>
                      Reaction used
                    </Tag>
                  ) : null,
                  entry.inLair ? (
                    <Tag tone="muted" dense>
                      Lair
                    </Tag>
                  ) : null,
                  companionOf !== undefined ? (
                    // A character's name of any length: cut, so the row's other tags keep their room.
                    <Tag tone="muted" dense cut={160} title={`Companion of ${companionOf}`}>
                      Companion of {companionOf}
                    </Tag>
                  ) : null,
                  legendary && legendary.actionsMax > 0 ? (
                    <Tag tone="turn" dense>
                      LA {legendary.actionsMax - legendary.actionsUsed}/{legendary.actionsMax}
                    </Tag>
                  ) : null,
                  legendary && legendary.resistMax > 0 ? (
                    <Tag tone="turn" dense>
                      LR {legendary.resistMax - legendary.resistUsed}/{legendary.resistMax}
                    </Tag>
                  ) : null,
                  effects.length > 0 ? <Chips effects={effects} max={6} /> : null,
                ]}
              />
            </span>
          </span>
        </button>
        <ValueBox entry={entry} name={name} editable={dm || (mine && typeTotals)} roll={rollBeside ? rollButton : null} />
        {dm || mine ? (
          // A disclosure: open shows in aria-expanded and the pressed look, never aria-pressed.
          <IconButton icon="more" label={`${name} options`} onClick={props.onExpand} pressed={props.expanded} aria-pressed={undefined} aria-expanded={props.expanded} />
        ) : (
          // Keeps the value column lined up with rows that have options.
          <span style={{ width: theme.touch, flex: "none" }} />
        )}
      </div>
      {rollAt ? <RollLanding at={rollAt} indent={slotted ? theme.touch + theme.space(1) : theme.space(2)} /> : null}
      {props.expanded ? (
        <RowMenu
          entry={entry}
          name={name}
          role={role}
          drag={drag}
          roll={rollBeside ? null : rollButton}
          legendaryTarget={legendaryTarget(token, characterId)}
          actor={actor}
          target={rowTarget({ tokens: token ? { [token.id]: token } : {}, characters: character ? { [character.id]: character } : {} }, entry)}
          readied={readied}
          playerOwned={playerOwned}
          statBlockTokenId={token && ((dm ? token.kind === "monster" || token.kind === "npc" : playerBlock) || pcBlock) ? token.id : null}
          revive={offersRevive(life, token?.kind)}
        />
      ) : null}
      {companions.length > 0 ? (
        // After the row's options, so those stay under the ⋯ that opened them. Inside the row, so its turn's tint covers them.
        <ul aria-label={`Acting on ${rowOwner ?? name}'s turn`} style={{ margin: 0, padding: `0 0 ${theme.space(1)}px`, display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
          {companions.map((c) => (
            <CompanionRow key={c.id} token={c} characterName={rowOwner ?? name} entryId={entry.id} role={role} onShow={() => props.onShowToken(c.id)} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Where focus goes once Revive leaves a row's options: the row's own button, the options staying open under it. */
/**
 * Whether a companion's player has a block to open from its rows: its bar's
 * rule (TokenActionBar.tsx), a creature companion with a block they read.
 * Undefined, for the DM or a token that is not the viewer's, it is false.
 */
function useCompanionBlockOpens(token: Token | undefined): boolean {
  const monsters = useRoomView((s) => s.view?.monsters);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  if (!token?.companion || !("inline" in token.actor)) return false;
  const actor = token.actor.inline;
  return opensStatBlock(statBlockShown({ dm: false, owner: true, kind: token.kind, actor, companion: true }), tokenStatBlock(actor, monsters, blocks));
}

const REVIVE_FOCUS_IN_ROW = { scope: "[data-entry-row]", to: ["[data-row-button]"] } as const;
/** The same for a listed companion's options, to its sub-row's button. */
const REVIVE_FOCUS_IN_SUB_ROW = { scope: "[data-companion-row]", to: ["[data-row-button]"] } as const;

const NO_COMPANIONS: Token[] = [];
const NO_HP: HpView = { kind: "none" };

/**
 * A companion that acts on its character's turn, listed under the
 * character's row (docs/design-v1-combat-flow.md 3.6.7): its picture, name,
 * AC, HP, conditions and its own Reaction and Ready, struck through when
 * dead. A tap does what a row tap does. It has no value box and no drag
 * handle, since it takes its character's place in the order. For the DM
 * and its owners, a ⋯ opens its Reaction, Ready, its stat block, and for
 * the DM Revive.
 */
function CompanionRow(props: { token: Token; characterName: string; entryId: string; role: "dm" | "player"; onShow(): void }) {
  const { token, role } = props;
  const dm = role === "dm";
  const [open, setOpen] = useState(false);
  const memberId = useRoomView((s) => s.you?.memberId);
  const characters = useRoomView((s) => s.view?.characters);
  const playerOwned = useRoomView((s) => (s.view ? playerPlays(s.view, { token }) : false));
  const lineId = useId();
  const name = displayName(token);
  const actor = "inline" in token.actor ? (token.actor.inline as ProjectedActor) : undefined;
  const hp = hpLess(actor, token) ? NO_HP : hpView(actor);
  const ac = rowAc(actor, token);
  const effects = actor?.effects ?? [];
  const readied = readiedEffect(effects);
  const dead = shownLife(actor, token) === "dead";
  const owner = ownsToken({ characters: characters ?? {} }, memberId, token);
  const spent = token.companion?.reactionUsed === true;
  const playerBlock = useCompanionBlockOpens(!dm && owner ? token : undefined);
  return (
    <li style={{ listStyle: "none" }} data-companion-row="">
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1), minHeight: theme.touch, paddingLeft: theme.touch }}>
        <button
          type="button"
          data-row-button=""
          onClick={props.onShow}
          aria-label={`${name}, acts on ${props.characterName}'s turn. Show it on the map with its actions.`}
          aria-describedby={lineId}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: theme.space(2),
            minHeight: theme.touch,
            padding: `${theme.space(0.5)}px 0`,
            background: "transparent",
            border: "none",
            color: theme.color.text,
            fontFamily: theme.font.body,
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <Portrait entry={{ tokenId: token.id }} size={28} dim={dead} />
          <span style={{ flex: 1, minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(0.5) }}>
            <span
              style={{
                fontSize: theme.font.body14,
                fontWeight: theme.weight.strong,
                color: dead ? theme.color.textMuted : theme.color.text,
                textDecoration: dead ? "line-through" : undefined,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {name}
            </span>
            <span id={lineId} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), fontSize: theme.font.small, color: theme.color.textMuted }}>
              <DescribedItems
                items={[
                  ac !== null ? <AcBadge ac={ac} size="sm" /> : null,
                  hp.kind !== "none" ? <DescribedHp hp={hp} /> : null,
                  dm && token.visibility === "dm" ? (
                    <Tag tone="muted" dense>
                      Hidden
                    </Tag>
                  ) : null,
                  readied ? (
                    <Tag tone="turn" dense>
                      Readied
                    </Tag>
                  ) : null,
                  spent ? (
                    <Tag tone="muted" dense>
                      Reaction used
                    </Tag>
                  ) : null,
                  effects.length > 0 ? <Chips effects={effects} max={6} /> : null,
                ]}
              />
            </span>
          </span>
        </button>
        {dm || owner ? (
          <IconButton icon="more" label={`${name} options`} onClick={() => setOpen((o) => !o)} pressed={open} aria-pressed={undefined} aria-expanded={open} />
        ) : (
          <span style={{ width: theme.touch, flex: "none" }} />
        )}
      </div>
      {open && (dm || owner) ? (
        <CompanionMenu
          token={token}
          entryId={props.entryId}
          dm={dm}
          readied={readied}
          playerOwned={playerOwned}
          spent={spent}
          dead={dead}
          statBlock={dm ? token.kind === "monster" || token.kind === "npc" : playerBlock}
        />
      ) : null}
    </li>
  );
}

/**
 * A listed companion's options: its own Reaction, its Ready on its
 * character's turn, its stat block, for the DM as on any monster or NPC
 * and for its players while it has one, and for the DM Revive.
 */
function CompanionMenu(props: { token: Token; entryId: string; dm: boolean; readied: Effect | undefined; playerOwned: boolean; spent: boolean; dead: boolean; statBlock: boolean }) {
  const { token, dm } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const here = usePanelHere();
  const reviveNoteId = useId();
  const target = { tokenId: token.id };
  return (
    <div style={{ padding: `0 ${theme.space(2)}px ${theme.space(3)}px ${theme.touch * 2}px`, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      {dm && props.dead && offersRevive("dead", token.kind) ? (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(2) }}>
          <ReviveButton target={target} describedBy={reviveNoteId} focusTo={REVIVE_FOCUS_IN_SUB_ROW} />
          <span id={reviveNoteId} style={{ flex: 1, minWidth: 0, fontSize: theme.font.small, color: theme.color.textMuted }}>
            {REVIVE_NOTE}
          </span>
        </div>
      ) : null}
      {/* Its own patch, which a device that holds the token predicts at once (shared/reads.ts). */}
      <Switch
        label="Reaction used"
        help="Its own, which clears when its character's turn starts"
        checked={props.spent}
        onChange={(on) => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { companionReaction: on } })}
      />
      <ReadyControls answer={{ kind: "companion", tokenId: token.id, entryId: props.entryId }} target={target} readied={props.readied} dm={dm} playerOwned={props.playerOwned} />
      {props.statBlock ? (
        <div style={{ display: "flex" }}>
          <Button size="sm" onClick={() => openStatBlock(scope, ui, token.id, { from: here })}>
            Stat block
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A row's own Reaction and turn, for its Ready (ready.ts reactionTarget's answer for a creature with its own row). */
function rowAnswer(entry: InitEntry): ReactionTarget {
  return entry.tokenId !== undefined ? { kind: "row", entryId: entry.id, tokenId: entry.tokenId } : { kind: "row", entryId: entry.id };
}

function legendaryTarget(token: { id: string; actor: { ref: string } | { inline: unknown } } | undefined, characterId: string | undefined) {
  if (token && "inline" in token.actor) return { tokenId: token.id };
  if (characterId !== undefined) return { characterId };
  return null;
}

/** Whether a row draws the drag handle's slot: the DM's, tied or in a wide order (RowDrag.slot). */
function handleSlot(dm: boolean, drag: RowDrag | null): boolean {
  return dm && (drag === null || drag.handle !== undefined || drag.slot);
}

function DragHandle(props: { drag: RowDrag | null; name: string }) {
  const handle = props.drag?.handle;
  return (
    <span
      data-drag-slot=""
      role={handle ? "button" : undefined}
      aria-label={handle ? `Drag to reorder ${props.name} within its tie` : undefined}
      aria-hidden={handle ? undefined : true}
      {...handle}
      style={{
        flex: "none",
        width: theme.touch,
        minHeight: theme.touch,
        display: "grid",
        placeItems: "center",
        color: handle ? theme.color.textMuted : "transparent",
        cursor: handle ? (props.drag?.dragging ? "grabbing" : "grab") : "default",
        touchAction: "none",
        userSelect: "none",
      }}
    >
      <svg width="12" height="18" viewBox="0 0 12 18" aria-hidden>
        {[3, 9, 15].map((y) => (
          <g key={y} fill="currentColor">
            <circle cx="3" cy={y} r="1.6" />
            <circle cx="9" cy={y} r="1.6" />
          </g>
        ))}
      </svg>
    </span>
  );
}

/**
 * The typed initiative result. Tapping it opens a box with a numeric
 * keypad. iOS's numeric keypad has no minus key, so a sign button sits
 * beside it for the rare negative roll. A player's value waits on the
 * server (design 7.4), with a spinner until it lands.
 */
function ValueBox(props: { entry: InitEntry; name: string; editable: boolean; roll?: ReactNode }) {
  const { entry } = props;
  const { send, waiting } = useSend();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    if (text === null) return;
    const parsed = parseInitiative(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setText(null);
    setError(null);
    if (parsed.value !== entry.value) send({ t: "encounter.setValue", entryId: entry.id, value: parsed.value });
  };

  const boxStyle: CSSProperties = {
    flex: "none",
    width: VALUE_BOX_PX,
    minHeight: theme.touch,
    borderRadius: theme.radius.sm,
    fontFamily: theme.font.body,
    fontVariantNumeric: "tabular-nums",
  };

  if (text === null) {
    const label = entry.value === null ? (props.editable ? "Set" : "?") : String(entry.value);
    const box = (
      <button
        type="button"
        disabled={!props.editable || waiting}
        onClick={() => {
          setText(valueText(entry.value));
          setError(null);
        }}
        aria-label={`${props.name} initiative ${entry.value ?? "not set"}${props.editable ? ", tap to type it" : ""}`}
        style={{
          ...boxStyle,
          display: "grid",
          placeItems: "center",
          background: props.editable ? theme.color.bg : "transparent",
          border: `${theme.line.border}px solid ${props.editable ? theme.color.controlBorder : "transparent"}`,
          color: entry.value === null ? theme.color.textMuted : theme.color.text,
          fontSize: entry.value === null ? theme.font.small : theme.font.title,
          fontWeight: theme.weight.bold,
          cursor: props.editable ? "pointer" : "default",
        }}
      >
        {waiting ? <Spinner label="Saving the value" /> : label}
      </button>
    );
    if (!props.roll) return box;
    return (
      <span style={{ flex: "none", display: "flex", alignItems: "center", gap: theme.space(1) }}>
        {props.roll}
        {box}
      </span>
    );
  }

  return (
    <span style={{ flex: "none", display: "flex", alignItems: "center", gap: theme.space(0.5) }}>
      <Button
        size="sm"
        aria-label="Flip the sign"
        // Keep the focus in the box, so the tap does not save the value early.
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setText((t) => (t === null ? t : t.trim().startsWith("-") ? t.trim().slice(1) : `-${t.trim()}`))}
        style={{ padding: 0, fontSize: theme.font.input }}
      >
        ±
      </Button>
      <input
        autoFocus
        aria-label={`${props.name} initiative`}
        aria-invalid={error ? true : undefined}
        title={error ?? undefined}
        inputMode="numeric"
        enterKeyHint="done"
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setText(null);
            setError(null);
          }
        }}
        style={{
          ...boxStyle,
          padding: `0 ${theme.space(1)}px`,
          textAlign: "center",
          background: theme.color.bg,
          border: `${theme.line.border}px solid ${error ? theme.color.danger : theme.color.accent}`,
          color: theme.color.text,
          fontSize: theme.font.input,
        }}
      />
    </span>
  );
}

/** The value box's width, which a row's Roll measures its room against. */
const VALUE_BOX_PX = 52;

/** The row a tap rolled for, whose words show under it until it lands (the write itself is the room's, useWatchInitiative). */
type RollAt = { entryId: string };

const INITIATIVE = { kind: "initiative" } as const;

/** The option store's row for a tracker row's roll, so a remounted row shows the roll still under way. */
function rollRow(entryId: string): string {
  return `init:${entryId}`;
}

/** The creature a row rolls for: its token, else its character. A label-only row has none. */
function rowCreature(tokenId: string | undefined, characterId: string | undefined): ActorTarget | null {
  if (tokenId !== undefined) return { tokenId };
  if (characterId !== undefined) return { characterId };
  return null;
}

/** An element's width while `on`, kept current as it resizes. 0 until measured. */
function useWidth(ref: RefObject<HTMLElement | null>, on: boolean): number {
  const [px, setPx] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return;
    const measure = () => setPx(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, on]);
  return px;
}

/**
 * Roll's fixed width: "Roll +10", the widest a bonus makes it, at the small
 * button's size with its tighter padding. Fixed, so the spinner that stands
 * in for the words while it rolls never moves the value box.
 */
const ROLL_PX = 72;
/** The least a name keeps beside Roll, as the group save's rows keep for theirs (docs/design-v1-roll-options.md Appendix D). */
const NAME_MIN_PX = 80;

/**
 * Whether a row's line has room for Roll beside its value box with 80 px
 * left for the name. The line holds the drag handle's slot where the row
 * has one, the row button around the name (its side padding, the 36 px
 * portrait and the gap after it), Roll, the box and the options button,
 * 4 px apart. That is 352 px for the DM's rows with the slot and 320 px
 * for a player's, so a 390 px phone has room. On a narrower line, such as
 * a phone's sheet at 130% or the DM's side panel, Roll waits at the top of
 * the row's options instead, so the name is never squeezed out. An
 * unmeasured line (0) has no room.
 */
function rollFitsBeside(linePx: number, slotted: boolean): boolean {
  const gap = theme.space(1);
  const slot = slotted ? theme.touch + gap : 0;
  const button = 2 * (slotted ? 0 : theme.space(2)) + 36 + theme.space(2);
  const rest = gap + ROLL_PX + gap + VALUE_BOX_PX + gap + theme.touch;
  return linePx - slot - button - rest >= NAME_MIN_PX;
}

/**
 * The row's "Roll +2" (docs/design-v1-roll-options.md 4.5): initiative
 * rolled on the server with the creature's bonus, its preset and the Dice
 * panel's choices, as the panel's own Initiative option rolls it. Busy
 * until its line lands, and disabled with the reason while a roll cannot
 * go. A creature this view does not hold, such as a token on another
 * scene, has no Roll: its bonus is not known here. A character rolled for
 * through a token lent to this player, whose numbers are its own players'
 * and the DM's, reads "Roll d20" and opens the Dice panel on it, where its
 * player types the bonus (LP7-PC-4).
 */
function InitiativeRoll(props: { entry: InitEntry; creature: ActorTarget; name: string; onRolled(at: RollAt): void }) {
  const { entry, creature } = props;
  const creatures = useMemo(() => [creature], [creature]);
  const { dice, failed } = useDiceView(creatures);
  const option = useRollOption();
  const options = useOptionStore();
  const ui = useRoomUi();
  const watch = useWatchInitiative();
  const blocked = useRollBlocked();
  const { waiting } = useRowResult(rollRow(entry.id));
  if (!dice) return null;
  const numbers = creatureRolls(dice, creature);
  const needs = srdNeeds(dice, creature);
  const loading = numbers === null && !failed && (needs.monsters || needs.rolls);
  if (numbers === null && !loading && !failed) return null;
  const roll = () => {
    if (!numbers) return;
    if (numbers.initBonus === null) {
      options.setState((s) => ({ focus: s.focus + 1, picked: creatureKey(dice.view, creature) }));
      ui.openPanel("dice");
      return;
    }
    const tag = option.d20({
      creature,
      test: INITIATIVE,
      bonus: numbers.initBonus,
      preset: presetFor(dice, creature, INITIATIVE, { rolls: numbers }),
      label: "Initiative",
      row: rollRow(entry.id),
      played: false,
      ask: false,
    });
    if (tag === null || tag === "asked") return;
    // The value the row holds now is what the write compares against once the line lands, wherever the row is by then.
    watch(tag, entry.id);
    props.onRolled({ entryId: entry.id });
  };
  const text = numbers ? (numbers.initBonus === null ? "Roll d20" : `Roll ${signedText(numbers.initBonus)}`) : "Roll";
  const reason = blocked ?? (failed ? "Its numbers did not load. Reload to try again." : null);
  return (
    <Button
      size="sm"
      busy={waiting || loading}
      disabled={reason !== null}
      title={reason ?? undefined}
      aria-label={`${text} initiative for ${props.name}${entry.value === null ? "" : `, replacing ${entry.value}`}`}
      onClick={roll}
      style={{ flex: "none", width: ROLL_PX, padding: `0 ${theme.space(2)}px` }}
    >
      {waiting || loading ? null : text}
    </Button>
  );
}

/**
 * What a row's Roll left once its line landed (docs/design-v1-roll-options.md
 * 4.3): the value written once, as a typed value goes, while the row still
 * holds the value it had at the tap. The box shows a value that went in, so
 * a line shows only when it did not: the row changed meanwhile, the server
 * refused the roll, or nobody knows yet whether it rolled. Mounted from the
 * tap on, so a row that never rolled reads no receipts.
 */
function RollLanding(props: { at: RollAt; indent: number }) {
  const { receipt, rolls, tag } = useRowResult(rollRow(props.at.entryId));
  const changed = useInitiativeChanged(tag);
  let words: string | null = null;
  let refused = false;
  if (changed && rolls[0]) words = `Rolled ${rolls[0].total}. ${changed}`;
  else if (receipt?.state === "refused" || receipt?.state === "unknown" || (receipt?.state === "committed" && rolls.length === 0)) {
    words = ownResultText(receipt);
    refused = receipt.state === "refused";
  }
  return (
    <div role="status" style={{ padding: words ? `0 ${theme.space(2)}px ${theme.space(1)}px ${props.indent}px` : 0, fontSize: theme.font.small, color: refused ? theme.color.dangerText : theme.color.textMuted }}>
      {words}
    </div>
  );
}

type Legendary = { actionsMax: number; actionsUsed: number; resistMax: number; resistUsed: number };

function RowMenu(props: {
  entry: InitEntry;
  name: string;
  role: "dm" | "player";
  drag: RowDrag | null;
  legendaryTarget: { tokenId: string } | { characterId: string } | null;
  actor: { legendary?: Legendary } | undefined;
  /** The row's creature for effect ops, when this view holds it. */
  target: ActorTarget | null;
  readied: Effect | undefined;
  playerOwned: boolean;
  /**
   * A token whose full stat block the row opens: a monster's or NPC's for
   * the DM (docs/design-v1-dm-tools.md 3.6), and a companion's with a block
   * for its players (docs/design-v1-companion-stat-blocks.md 6.7).
   */
  statBlockTokenId: string | null;
  /** The row's creature is dead: the DM's Revive comes first, for a row whose token has no bar in this view (docs/design-v1-combat-flow.md 3.5). */
  revive: boolean;
  /** The row's Roll, here when its line has no room for it beside the value box, or the row has a value it would replace. */
  roll?: ReactNode;
}) {
  const { entry, role, drag } = props;
  const reviveNoteId = useId();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const here = usePanelHere();
  const remove = useSend();
  const reaction = useSend();
  const dm = role === "dm";
  const update = (patch: { hidden?: boolean; reactionUsed?: boolean; inLair?: boolean; advantage?: "adv" | "dis" | null }) =>
    actions.dispatch({ t: "encounter.update", entryId: entry.id, patch });
  const legendary = props.actor?.legendary;
  const setLegendary = (next: Legendary) => {
    const target = props.legendaryTarget;
    if (!target) return;
    if ("tokenId" in target) actions.dispatch({ t: "token.update", tokenId: target.tokenId, patch: { actor: { legendary: next } } });
    else actions.dispatch({ t: "character.update", characterId: target.characterId, patch: { actor: { legendary: next } } });
  };

  return (
    <div
      style={{
        // Lined up with the row's name, after the handle's slot where the row has one.
        padding: `0 ${theme.space(2)}px ${theme.space(3)}px ${handleSlot(dm, drag) ? theme.touch + theme.space(1) : theme.space(2)}px`,
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(1),
      }}
    >
      {dm && props.revive && props.target ? (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(2) }}>
          <ReviveButton target={props.target} describedBy={reviveNoteId} focusTo={REVIVE_FOCUS_IN_ROW} />
          <span id={reviveNoteId} style={{ flex: 1, minWidth: 0, fontSize: theme.font.small, color: theme.color.textMuted }}>
            {REVIVE_NOTE}
          </span>
        </div>
      ) : null}
      {props.roll ? (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.small, color: theme.color.textMuted }}>{entry.value === null ? "Initiative, sets its row" : `Roll again, replaces ${entry.value}`}</span>
          {props.roll}
        </div>
      ) : null}
      {dm ? (
        <>
          <Switch label="Hidden from players" help="Players do not see this row" checked={entry.hidden} onChange={(hidden) => update({ hidden })} />
          <Switch label="Reaction used" help="Clears at the start of its turn" checked={entry.reactionUsed} onChange={(reactionUsed) => update({ reactionUsed })} />
          <Switch label="In lair" checked={entry.inLair} onChange={(inLair) => update({ inLair })} />
          {props.target ? <ReadyControls answer={rowAnswer(entry)} target={props.target} readied={props.readied} dm playerOwned={props.playerOwned} /> : null}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
            <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>Initiative roll reminder. Auto follows its conditions.</span>
            <div role="group" aria-label="Initiative roll reminder" style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
              <Button size="sm" pressed={entry.advantage === undefined} onClick={() => update({ advantage: null })} aria-label="From its conditions">
                Auto
              </Button>
              <Button size="sm" pressed={entry.advantage === "adv"} onClick={() => update({ advantage: "adv" })}>
                Advantage
              </Button>
              <Button size="sm" pressed={entry.advantage === "dis"} onClick={() => update({ advantage: "dis" })}>
                Disadvantage
              </Button>
            </div>
          </div>
          <RowRollTools entry={entry} />
          {props.statBlockTokenId !== null ? (
            <div style={{ display: "flex" }}>
              <Button
                size="sm"
                onClick={() => openStatBlock(scope, ui, props.statBlockTokenId!, { from: here })}
              >
                Stat block
              </Button>
            </div>
          ) : null}
          {legendary && legendary.actionsMax > 0 ? (
            <Pips
              label="Legendary actions used"
              max={legendary.actionsMax}
              used={legendary.actionsUsed}
              onChange={(actionsUsed) => setLegendary({ ...legendary, actionsUsed })}
            />
          ) : null}
          {legendary && legendary.resistMax > 0 ? (
            <Pips
              label="Legendary resistances used today"
              max={legendary.resistMax}
              used={legendary.resistUsed}
              onChange={(resistUsed) => setLegendary({ ...legendary, resistUsed })}
            />
          ) : null}
          {drag && (drag.canMoveUp || drag.canMoveDown) ? (
            <div style={{ display: "flex", gap: theme.space(1), alignItems: "center" }}>
              <span style={{ flex: 1, fontSize: theme.font.small, color: theme.color.textMuted }}>Tied: you decide who goes first</span>
              <Button size="sm" disabled={!drag.canMoveUp} onClick={() => drag.moveBy(-1)}>
                Move up
              </Button>
              <Button size="sm" disabled={!drag.canMoveDown} onClick={() => drag.moveBy(1)}>
                Move down
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <Switch
            label="Reaction used"
            help="Clears at the start of your turn"
            checked={entry.reactionUsed}
            busy={reaction.waiting}
            onChange={(reactionUsed) => reaction.send({ t: "encounter.update", entryId: entry.id, patch: { reactionUsed } })}
          />
          {props.target ? <ReadyControls answer={rowAnswer(entry)} target={props.target} readied={props.readied} dm={false} playerOwned={props.playerOwned} /> : null}
          {props.statBlockTokenId !== null ? (
            <div style={{ display: "flex" }}>
              <Button size="sm" onClick={() => openStatBlock(scope, ui, props.statBlockTokenId!, { from: here })}>
                Stat block
              </Button>
            </div>
          ) : null}
        </>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="sm" variant="danger" busy={remove.waiting} onClick={() => remove.send({ t: "encounter.remove", entryIds: [entry.id] })}>
          Remove from the fight
        </Button>
      </div>
    </div>
  );
}

/** Tap a pip to mark that many used. Tapping the last used pip gives one back. */
function Pips(props: { label: string; max: number; used: number; onChange(used: number): void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
      <span style={{ flex: 1, fontSize: theme.font.small, color: theme.color.textMuted }}>
        {props.label}: {props.used} of {props.max}
      </span>
      <div role="group" aria-label={props.label} style={{ display: "flex" }}>
        {Array.from({ length: props.max }, (_, i) => {
          const filled = i < props.used;
          return (
            <button
              key={i}
              type="button"
              aria-label={`${i + 1} used`}
              aria-pressed={filled}
              onClick={() => props.onChange(props.used === i + 1 ? i : i + 1)}
              style={{
                width: theme.touch,
                minHeight: theme.touch,
                display: "grid",
                placeItems: "center",
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: theme.radius.round,
                  border: `${theme.line.strong}px solid ${theme.color.accent}`,
                  background: filled ? theme.color.accent : "transparent",
                }}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
