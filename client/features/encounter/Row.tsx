import { useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref } from "react";
import type { Effect, InitEntry } from "#shared/model.ts";
import { playerPlays } from "#shared/project.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Switch } from "../../components/Switch.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { openStatBlock } from "../tokens/statBlockOpen.ts";
import { RowRollTools } from "./AutoInitiative.tsx";
import { useSend } from "./hooks.ts";
import { entryActor, entryName, hpView, parseInitiative, rollReminder, valueText } from "./logic.ts";
import { Chips, HpReadout, Portrait, RollBadge, Spinner } from "./parts.tsx";
import { readiedEffect, rowTarget } from "./ready.ts";
import { ReadyControls } from "./ReadyControls.tsx";

export type RowDrag = {
  /** Pointer handlers for the drag handle. Absent when the row has no tie to reorder. */
  handle?: {
    onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
    onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
    onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
    onPointerCancel(e: ReactPointerEvent<HTMLElement>): void;
  };
  /** Pixels the row is shifted while a drag is in progress. */
  offset: number;
  dragging: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  moveBy(step: -1 | 1): void;
};

/**
 * One initiative row: picture, name, HP as the viewer may see it, AC for
 * the DM, condition chips, roll reminders and the typed value. The DM's
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
  /** "Select several" is on: a tap picks the creature for the shared HP entry instead of showing it. */
  picking: boolean;
  /** Picked for the shared HP entry. */
  selected: boolean;
  onExpand(): void;
  onShow(): void;
  drag: RowDrag | null;
  rowRef: Ref<HTMLLIElement>;
}) {
  const { entry, active, role, mine } = props;
  const dm = role === "dm";
  const name = useRoomView((s) => (s.view ? entryName(s.view, entry) : ""));
  const token = useRoomView((s) => (entry.tokenId !== undefined ? s.view?.tokens[entry.tokenId] : undefined));
  const characterId = entry.characterId ?? (token && "ref" in token.actor ? token.actor.ref : undefined);
  const character = useRoomView((s) => (characterId !== undefined ? s.view?.characters[characterId] : undefined));
  const actor = entryActor(
    { tokens: token ? { [token.id]: token } : {}, characters: character ? { [character.id]: character } : {} },
    entry.tokenId !== undefined ? { tokenId: entry.tokenId } : entry.characterId !== undefined ? { characterId: entry.characterId } : {},
  );
  const hp = hpView(actor);
  const effects = actor?.effects ?? [];
  // Whoever rolls this creature's initiative sees the reminder: the DM for every row, a player for their own.
  const reminder = dm || mine ? rollReminder(entry, effects) : undefined;
  const legendary = dm ? actor?.legendary : undefined;
  const readied = readiedEffect(effects);
  // A Ready action's trigger reaches other players only on a creature a player plays (shared/project.ts).
  const playerOwned = useRoomView((s) => {
    if (!s.view) return false;
    if (token && "inline" in token.actor) return playerPlays(s.view, { token });
    return character ? playerPlays(s.view, { character }) : false;
  });
  const dead = actor?.life === "dead";
  const drag = props.drag;

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
    <li ref={props.rowRef} style={rowStyle} aria-current={active ? "step" : undefined}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1), minHeight: 56 }}>
        {dm ? <DragHandle drag={drag} name={name} /> : null}
        <button
          type="button"
          onClick={props.onShow}
          aria-label={`${name}${active ? ", acting now" : ""}. ${props.picking ? "Pick for the shared HP entry" : "Show it on the map with its actions"}`}
          aria-pressed={props.picking ? props.selected : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: theme.space(2),
            minHeight: theme.touch,
            padding: `${theme.space(1)}px ${dm ? 0 : theme.space(2)}px`,
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
            <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), fontSize: theme.font.small, color: theme.color.textMuted }}>
              <HpReadout hp={hp} />
              {dm && actor?.ac !== undefined ? <span>AC {actor.ac}</span> : null}
              {reminder ? <RollBadge kind={reminder} /> : null}
              {dm && entry.hidden ? (
                <Tag tone="muted" dense>
                  Hidden
                </Tag>
              ) : null}
              {readied ? (
                <Tag tone="turn" dense>
                  Readied
                </Tag>
              ) : null}
              {entry.reactionUsed ? (
                <Tag tone="muted" dense>
                  Reaction used
                </Tag>
              ) : null}
              {entry.inLair ? (
                <Tag tone="muted" dense>
                  Lair
                </Tag>
              ) : null}
              {legendary && legendary.actionsMax > 0 ? (
                <Tag tone="turn" dense>
                  LA {legendary.actionsMax - legendary.actionsUsed}/{legendary.actionsMax}
                </Tag>
              ) : null}
              {legendary && legendary.resistMax > 0 ? (
                <Tag tone="turn" dense>
                  LR {legendary.resistMax - legendary.resistUsed}/{legendary.resistMax}
                </Tag>
              ) : null}
              <Chips effects={effects} max={6} />
            </span>
          </span>
        </button>
        <ValueBox entry={entry} name={name} editable={dm || mine} />
        {dm || mine ? (
          // A disclosure: open shows in aria-expanded and the pressed look, never aria-pressed.
          <IconButton icon="more" label={`${name} options`} onClick={props.onExpand} pressed={props.expanded} aria-pressed={undefined} aria-expanded={props.expanded} />
        ) : (
          // Keeps the value column lined up with rows that have options.
          <span style={{ width: theme.touch, flex: "none" }} />
        )}
      </div>
      {props.expanded ? (
        <RowMenu
          entry={entry}
          name={name}
          role={role}
          drag={drag}
          legendaryTarget={legendaryTarget(token, characterId)}
          actor={actor}
          target={rowTarget({ tokens: token ? { [token.id]: token } : {}, characters: character ? { [character.id]: character } : {} }, entry)}
          readied={readied}
          playerOwned={playerOwned}
          statBlockTokenId={token && (token.kind === "monster" || token.kind === "npc") ? token.id : null}
        />
      ) : null}
    </li>
  );
}

function legendaryTarget(token: { id: string; actor: { ref: string } | { inline: unknown } } | undefined, characterId: string | undefined) {
  if (token && "inline" in token.actor) return { tokenId: token.id };
  if (characterId !== undefined) return { characterId };
  return null;
}

function DragHandle(props: { drag: RowDrag | null; name: string }) {
  const handle = props.drag?.handle;
  return (
    <span
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
function ValueBox(props: { entry: InitEntry; name: string; editable: boolean }) {
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
    width: 52,
    minHeight: theme.touch,
    borderRadius: theme.radius.sm,
    fontFamily: theme.font.body,
    fontVariantNumeric: "tabular-nums",
  };

  if (text === null) {
    const label = entry.value === null ? (props.editable ? "Set" : "?") : String(entry.value);
    return (
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
  /** A monster's or NPC's token, whose full stat block the DM can open from the row (docs/design-v1-dm-tools.md 3.6). */
  statBlockTokenId: string | null;
}) {
  const { entry, role, drag } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
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
    <div style={{ padding: `0 ${theme.space(2)}px ${theme.space(3)}px ${dm ? theme.touch + theme.space(1) : theme.space(2)}px`, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      {dm ? (
        <>
          <Switch label="Hidden from players" help="Players do not see this row" checked={entry.hidden} onChange={(hidden) => update({ hidden })} />
          <Switch label="Reaction used" help="Clears at the start of its turn" checked={entry.reactionUsed} onChange={(reactionUsed) => update({ reactionUsed })} />
          <Switch label="In lair" checked={entry.inLair} onChange={(inLair) => update({ inLair })} />
          {props.target ? <ReadyControls entryId={entry.id} target={props.target} readied={props.readied} dm playerOwned={props.playerOwned} /> : null}
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
                onClick={() => openStatBlock(scope, ui, props.statBlockTokenId!)}
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
          {props.target ? <ReadyControls entryId={entry.id} target={props.target} readied={props.readied} dm={false} playerOwned={props.playerOwned} /> : null}
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
