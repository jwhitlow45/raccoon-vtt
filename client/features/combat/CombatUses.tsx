import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useStore } from "zustand";
import type { LimitedUse } from "#shared/dice/uses.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { PromptKey } from "#shared/model.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Loading } from "../../components/Loading.tsx";
import { buttonLook } from "../../components/looks.ts";
import { handFocusTo } from "../../lib/handFocus.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import type { OnAnswer } from "../../state/types.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { rollTrouble, useCardRoll } from "../encounter/CardRoll.tsx";
import { useAnyPending } from "../encounter/hooks.ts";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { ClassResourceRows } from "../resources/ResourceRows.tsx";
import { reasonText } from "../resources/logic.ts";
import { useOption } from "../dice/optionState.ts";
import { useReceipts } from "../dice/useReceipt.ts";
import { useRollBlocked } from "../dice/useRollOption.ts";
import { combatLocalSlot, promptId, rechargeRow, tellPassed, useActsNow, useCreatureUses, useListRolls } from "./state.ts";
import {
  abilityHead,
  abilityOp,
  abilityState,
  actorOf,
  characterIdOf,
  currentRecord,
  dayLeft,
  holderKey,
  legendaryHead,
  legendaryLabel,
  legendaryOffText,
  legendaryOp,
  legendaryText,
  listRollTrouble,
  openRecord,
  otherBackOp,
  otherHead,
  promptOp,
  rechargeRollOp,
  regenerationLine,
  resistHead,
  resistOp,
  turnKey,
  usesPresence,
  usesRows,
  type LegendaryButton,
  type UseRow,
  type UsesForm,
} from "./logic.ts";

/**
 * One creature's combat uses (docs/design-v1-combat-controls.md 4.2, 5 and
 * 6), the one list the turn card (`card`), the tracker row's Uses group and
 * the token bar's Uses drawer (`list`) share: Legendary Resistance and
 * legendary actions with their pips, the block's recharge, rest and X/Day
 * abilities, the marks its block no longer lists, Regeneration's line, the
 * turn's skipped prompts and the character's class resources. `uses` is
 * the block's (state.ts useCreaturesUses), null while it loads, so counts
 * on the actor show at once and the rows that need the block wait under
 * the shared Loading.
 *
 * Each button waits for the server's answer, busy and deaf to a second
 * tap, since a use's rules are the server's. One status line under the
 * list says why a tap was refused, or why an off button cannot act now: an
 * off button keeps its focus and its tap (`aria-disabled`), so a touch
 * reaches its reason too.
 */
export function CombatUses(props: { target: ActorTarget; form: UsesForm; uses: readonly LimitedUse[] | null; loading: boolean; failed: boolean; ownTurn: boolean; name: string }) {
  const { target, form } = props;
  const actor = useRoomView((s) => (s.view ? actorOf(s.view, target) : undefined));
  const encounter = useRoomView((s) => s.view?.encounter);
  const characterId = useRoomView((s) => (s.view ? characterIdOf(s.view, target) : undefined));
  const holder = useRoomView((s) => (s.view ? holderKey(s.view, target) : ""));
  const record = currentRecord(encounter, actor);
  const turn = turnKey(encounter);
  const rows = usesRows({ form, uses: props.uses, actor, ownTurn: props.ownTurn, record });
  const [status, setStatus] = useState<{ text: string; refused: boolean } | null>(null);
  const trouble = useListRollTrouble(
    holder,
    rows.flatMap((r) => (r.kind === "ability" && r.use.kind === "recharge" ? [r.use.key] : [])),
    turn,
  );
  // The roll's trouble stands until the list's next tap says something of its own, then stays away for that roll.
  const onStatus = (next: { text: string; refused: boolean } | null) => {
    setStatus(next);
    trouble.silence();
  };
  const shown = status ?? (trouble.shown ? { text: trouble.shown.text, refused: true } : null);
  const seenTag = status === null ? (trouble.shown?.tag ?? null) : null;
  const see = trouble.see;
  useEffect(() => {
    if (seenTag !== null) see(seenTag);
  }, [seenTag, see]);
  const waits = props.uses === null && (props.loading || props.failed);
  if (rows.length === 0 && !waits && characterId === undefined) return null;
  return (
    <div data-combat-uses={form} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      {rows.length > 0 ? (
        <ul aria-label={`${props.name}'s uses`} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
          {rows.map((row) => (
            <UseLine key={rowKey(row)} row={row} target={target} holder={holder} form={form} record={record?.id} turn={turn} encounter={encounter} actor={actor} onStatus={onStatus} />
          ))}
        </ul>
      ) : null}
      {waits ? props.failed ? <SrdLoadFailed what="The uses" inline /> : <Loading text="Loading the uses…" style={{ minHeight: theme.touch }} /> : null}
      {characterId !== undefined ? <ClassResourceRows characterId={characterId} form={form} /> : null}
      {shown ? (
        <p role="status" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: shown.refused ? theme.color.dangerText : theme.color.textMuted }}>
          {shown.text}
        </p>
      ) : null}
    </div>
  );
}

/** The off-turn list for a creature, reading its block and whose turn it is itself: the tracker row's Uses group, a companion's and the token bar's Uses drawer. */
export function CreatureUses(props: { target: ActorTarget; name: string }) {
  const read = useCreatureUses(props.target);
  const ownTurn = useActsNow(props.target);
  return <CombatUses {...props} form="list" ownTurn={ownTurn} uses={read.uses} loading={read.loading} failed={read.failed} />;
}

/**
 * The token bar's Uses drawer (docs/design-v1-combat-controls.md 6): the
 * creature's off-turn list, as its tracker row's group holds it. It opens
 * on its first button, so a keyboard lands in it, and Escape closes it
 * alone, never the bar around it. It takes focus itself when a press
 * leaves it with no button, as Restore beside Regeneration does, so that
 * Escape still reaches it.
 */
export function UsesDrawer(props: { target: ActorTarget; name: string; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    // In a bar shrunk short the drawer opens above the rows, out of sight without this, as Conditions does.
    box.scrollIntoView({ block: "nearest" });
    box.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={`${props.name}'s uses`}
      data-uses-drawer=""
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        props.onClose();
      }}
      style={{ display: "grid", gap: theme.space(1) }}
    >
      <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>Uses</div>
      <CreatureUses target={props.target} name={props.name} />
    </div>
  );
}

/** Whether a creature has uses to show (logic.ts usesPresence), reading its block. */
export function useUsesPresence(target: ActorTarget | null): "yes" | "loading" | "no" {
  const actor = useRoomView((s) => (target && s.view ? actorOf(s.view, target) : undefined));
  const resources = useRoomView((s) => {
    const id = target && s.view ? characterIdOf(s.view, target) : undefined;
    return id !== undefined ? s.view?.characters[id]?.resources : undefined;
  });
  const read = useCreatureUses(target);
  if (!target) return "no";
  return usesPresence({ actor, resources, uses: read.uses, loading: read.loading });
}

function rowKey(row: UseRow): string {
  switch (row.kind) {
    case "ability":
      return `ability:${row.use.key}`;
    case "other":
      return `other:${row.key}`;
    case "skipped":
      return `skipped:${row.what}`;
    default:
      return row.kind;
  }
}

/**
 * The prompt card a skipped row's Reopen brings back, by its id in the
 * alerts column (RegenerationCard.tsx, DeathSaveCard.tsx and
 * encounter/RechargeCard.tsx name theirs so).
 */
function reopenedCard(holder: string, record: number, what: PromptKey): string {
  const kind = what === "regeneration" || what === "deathSave" ? what : "recharge";
  return `[data-alert-id="${CSS.escape(`${kind}:${promptId(holder, record, what)}`)}"]`;
}

/** A control a reader and a keyboard can reach: on the page and drawn. */
function reachable(el: HTMLElement | null | undefined): HTMLElement | null {
  return el && el.isConnected && el.getClientRects().length > 0 ? el : null;
}

/**
 * Where focus goes once a press took its button away (D-261024-43): the
 * row's first button, else the list's, else the prompt card a Reopen
 * brought back, else the turn card, the drawer's first button, the
 * drawer itself or the bar's frame that held the list, else the tracker
 * row's own button.
 * Never the page.
 */
function usesFocusTarget(near: Record<"list" | "card" | "drawer" | "frame" | "trackerRow", HTMLElement | null>, key: string, reopened: string | null): HTMLElement | null {
  const list = reachable(near.list);
  return (
    reachable(list?.querySelector<HTMLElement>(`[data-use-key="${CSS.escape(key)}"] button`)) ??
    reachable(list?.querySelector<HTMLElement>("button")) ??
    (reopened ? reachable(document.querySelector<HTMLElement>(reopened)?.querySelector<HTMLElement>("button")) : null) ??
    reachable(near.card) ??
    reachable(reachable(near.drawer)?.querySelector<HTMLElement>("button")) ??
    reachable(near.drawer) ??
    reachable(near.frame) ??
    reachable(reachable(near.trackerRow)?.querySelector<HTMLElement>("[data-row-button]"))
  );
}

type LineProps = {
  row: UseRow;
  target: ActorTarget;
  holder: string;
  form: UsesForm;
  record: number | undefined;
  /** The turn the list shows (logic.ts turnKey), kept with each Roll recharge it sends. */
  turn: string | null;
  encounter: Parameters<typeof openRecord>[0];
  actor: Parameters<typeof openRecord>[1];
  onStatus(status: { text: string; refused: boolean } | null): void;
};

/** One row's line: its words, then its buttons on a line of their own under them. */
function UseLine(props: LineProps) {
  const { row, target, form } = props;
  const send = useUseSend(props.onStatus);
  const recharge = useRechargeRoll(props.holder, row.kind === "ability" ? row.use.key : "", props.turn, props.onStatus);
  const id = useId();
  const line = useRef<HTMLLIElement>(null);
  /*
   * A press often takes its own button away: Restore once the use is back, a recharge's Use as it turns into Roll
   * recharge and Mark ready, a skipped prompt's row with its Reopen. Focus then falls to the page, and the next
   * Escape closes the whole bar rather than the drawer, so it moves to the row's first button, or the list's. The
   * last button can take the whole list with it, and the turn card or the drawer around it too, so the places it
   * may move to are taken as the press finds them and read once the button has gone (D-261024-43).
   */
  const keepFocus = () => {
    const li = line.current;
    if (!li) return;
    const near = {
      list: li.closest<HTMLElement>("[data-combat-uses]"),
      card: li.closest<HTMLElement>('[data-alert="turn"]'),
      drawer: li.closest<HTMLElement>("[data-uses-drawer]"),
      frame: li.closest<HTMLElement>('[role="dialog"][data-bar-mode]'),
      trackerRow: li.closest<HTMLElement>("[data-companion-row], [data-entry-row]"),
    };
    const reopened = row.kind === "skipped" && props.record !== undefined ? reopenedCard(props.holder, props.record, row.what) : null;
    handFocusTo(() => usesFocusTarget(near, rowKey(row), reopened));
  };
  let head: ReactNode;
  let state: string | null = null;
  const buttons: ReactNode[] = [];
  const add = (key: string, b: Omit<UseButtonProps, "busy"> & { op?: ClientOp | null }) => {
    const { op, ...rest } = b;
    const press = rest.onClick ?? (() => op && send.send(key, op));
    buttons.push(
      <UseButton
        key={key}
        {...rest}
        busy={send.busy === key}
        onClick={() => {
          press();
          keepFocus();
        }}
      />,
    );
  };
  switch (row.kind) {
    case "resist":
      head = resistHead(row);
      add("use", { text: "Use", label: `Use Legendary Resistance, ${row.left} left`, off: row.left === 0 ? "No Legendary Resistance left." : null, offId: `${id}-off`, op: resistOp(target), onOff: props.onStatus });
      if (form === "list" && row.left < row.max) add("back", { text: "Restore", label: "Restore one Legendary Resistance", op: resistOp(target, true) });
      break;
    case "legendary":
      head = legendaryHead(row, form);
      for (const [i, b] of row.buttons.entries()) {
        const off = legendaryOffText(b);
        add(`la${i}`, { text: legendaryText(b), label: legendaryLabel(b, row.left), off: off === null ? null : `${b.name || "A legendary action"}: ${off.toLowerCase()}.`, offId: `${id}-la${i}`, op: legendaryOp(target, b), onOff: props.onStatus });
      }
      if (form === "list" && row.left < row.max) add("back", { text: "Restore", label: "Restore one legendary action", op: legendaryBackOp(target, row.buttons, props.actor) });
      break;
    case "ability": {
      head = abilityHead(row);
      state = abilityState(row, recharge.total);
      const { use, mark } = row;
      if (use.kind === "day") {
        const left = dayLeft(use, mark);
        if (form === "card" && left === 0) break;
        add("use", { text: "Use", label: `Use ${use.name}, ${left} left`, off: left === 0 ? `No uses of ${use.name} left.` : null, offId: `${id}-off`, op: abilityOp(target, use), onOff: props.onStatus });
        if (form === "list" && mark) add("back", { text: "Restore", label: `Restore one use of ${use.name}`, op: abilityOp(target, use, { back: true }) });
        break;
      }
      if (!mark) {
        add("use", { text: "Use", label: `Use ${use.name}`, op: abilityOp(target, use) });
        break;
      }
      if (form === "card") break;
      if (use.kind === "recharge") {
        buttons.push(
          <UseButton
            key="roll"
            text="Roll recharge"
            label={`Roll the recharge of ${use.name}, 1d6`}
            busy={recharge.waiting}
            off={recharge.blocked}
            offId={`${id}-roll`}
            onOff={props.onStatus}
            onClick={() => {
              recharge.roll(target, use, openRecord(props.encounter, props.actor, `recharge:${use.key}`));
              keepFocus();
            }}
          />,
        );
      }
      add("ready", { text: "Mark ready", label: `Mark ${use.name} ready`, op: abilityOp(target, use, { back: true }) });
      break;
    }
    case "other":
      head = otherHead(row.mark);
      add("back", { text: "Restore", label: `Restore ${row.mark.name}`, op: otherBackOp(target, row.key, row.mark) });
      break;
    case "regeneration":
      head = regenerationLine(row.amount);
      break;
    case "skipped":
      head = row.text;
      if (props.record !== undefined) add("reopen", { text: "Reopen", label: `Reopen: ${row.text}`, op: promptOp(target, props.record, row.what as PromptKey, "open") });
      break;
  }
  return (
    <li ref={line} data-use-row={row.kind} data-use-key={rowKey(row)} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1), minHeight: theme.touch }}>
      <div style={{ flex: "1 1 auto", minWidth: 0, fontSize: theme.font.body14, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
        <span style={{ fontWeight: theme.weight.strong }}>{head}</span>
        {state ? <span style={{ color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>{`, ${state}`}</span> : null}
      </div>
      {/*
       * The buttons take a line of their own under the row's words, each growing to fill it, as a card's do. Beside
       * the words where they fit, a row's height would follow how many buttons it holds, so a full Legendary
       * Resistance's lone Use would stand a line shorter than its Restore, and than the rows around it.
       */}
      {buttons.length > 0 ? <div style={{ flex: "1 1 100%", minWidth: 0, maxWidth: "100%", display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>{buttons}</div> : null}
    </li>
  );
}

/**
 * Restore for legendary actions: the first once-a-turn action still
 * marked, with its pips, else one pip, so a mis-tap of Fiery Rays frees
 * Fiery Rays again.
 */
function legendaryBackOp(target: ActorTarget, buttons: readonly LegendaryButton[], actor: LineProps["actor"]): ClientOp {
  const marked = buttons.find((b) => b.key !== undefined && b.off === "once");
  if (marked?.key !== undefined && actor?.uses && Object.hasOwn(actor.uses, marked.key)) return { t: "actor.use", target, use: { kind: "legendary", cost: marked.cost, key: marked.key, name: marked.name }, back: true };
  return { t: "actor.use", target, use: { kind: "legendary", cost: 1 }, back: true };
}

/** A use's op, busy until the server answers it, with a refusal sent to the list's status line. */
function useUseSend(onStatus: LineProps["onStatus"]) {
  const actions = useRoomActions();
  const [sent, setSent] = useState<{ key: string; n: number } | null>(null);
  const pending = useAnyPending(sent === null ? [] : [sent.n]);
  return {
    busy: pending ? (sent?.key ?? null) : null,
    send(key: string, op: ClientOp) {
      if (pending) return;
      const onAnswer: OnAnswer = (answer, refusal) => onStatus(answer === "refused" ? { text: reasonText(refusal), refused: true } : null);
      const n = actions.dispatch(op, { quiet: true, onAnswer });
      if (n === null) onStatus({ text: "That could not be sent.", refused: true });
      else setSent({ key, n });
    },
  };
}

/**
 * Roll recharge from the list: `actor.rechargeRoll` on the server, on the
 * Dice panel's own row for that recharge, so its result shows in both. It
 * settles the turn's open prompt for the key where one is open (2.3).
 */
function useRechargeRoll(holder: string, key: string, turn: string | null, onStatus: LineProps["onStatus"]) {
  const row = rechargeRow(holder, key);
  const card = useCardRoll(row);
  const blocked = useRollBlocked();
  // Only a roll a uses list sent says its result here: the row's other rolls are the Dice panel's to show.
  const lists = useListRolls();
  const mine = lists.rolls[row]?.tag ?? null;
  const total = mine !== null && card.tag === mine ? card.rolls[0]?.total : undefined;
  return {
    waiting: card.waiting,
    blocked,
    total,
    roll(target: ActorTarget, use: { key: string; name: string; min: number }, record: number | undefined) {
      if (card.waiting || blocked) return;
      const tag = uuidv7();
      if (card.send(rechargeRollOp(tag, target, use, record)) === null) onStatus({ text: "That roll could not be sent. Try again.", refused: true });
      else {
        lists.remember(row, { tag, turn });
        onStatus(null);
      }
    },
  };
}

/**
 * Why a Roll recharge the uses lists sent for one of these recharges did
 * not land (logic.ts listRollTrouble): refused, as when another device
 * settled its prompt first, or lost on the way. The roll goes quiet and its
 * line watches its receipt, so no toast says it, except one that came once
 * its turn had passed, which this list then toasts itself, once for every
 * list. `silence` puts away what it shows, for the list's next tap, and
 * `see` marks what it showed.
 */
function useListRollTrouble(holder: string, keys: readonly string[], turn: string | null) {
  const local = useScoped(combatLocalSlot);
  const rolls = useStore(local, (s) => s.rolls);
  const silenced = useStore(local, (s) => s.silenced);
  const seen = useStore(local, (s) => s.seen);
  const newest = useOption((s) => s.tags);
  const tracker = useReceipts();
  useSyncExternalStore(tracker.subscribe, tracker.version, tracker.version);
  const ui = useRoomUi();
  const trouble = (tag: string) => rollTrouble(tracker.state(tag), false);
  // What stood as this list opened, so it never shows a failure again that a list showed, nor one with no turn from before.
  const [opened] = useState(() => {
    const now = local.getState();
    return { seen: new Set(now.seen), failed: new Set(Object.values(now.rolls).flatMap((r) => (trouble(r.tag) ? [r.tag] : []))) };
  });
  const { shown, passed } = listRollTrouble({ rows: keys.map((key) => rechargeRow(holder, key)), rolls, newest, turn, trouble, silenced, seen, opened });
  const passedTags = passed.map((p) => p.tag).join(" ");
  useEffect(() => {
    if (passedTags) tellPassed(passedTags.split(" "), local, tracker, (text, tone) => ui.notify(text, tone));
  }, [passedTags, local, tracker, ui]);
  const see = useCallback(
    (tag: string) => {
      if (!local.getState().seen.has(tag)) local.setState((s) => ({ seen: new Set([...s.seen, tag]) }));
    },
    [local],
  );
  return {
    shown,
    silence: () => {
      if (shown) local.setState((s) => ({ silenced: new Set([...s.silenced, shown.tag]) }));
    },
    see,
  };
}

type UseButtonProps = {
  text: string;
  label: string;
  busy?: boolean;
  /** Why it cannot act now, or null: it keeps its focus, says so to a reader, and a tap puts it in the status line. */
  off?: string | null;
  offId?: string;
  onOff?(status: { text: string; refused: boolean } | null): void;
  onClick?(): void;
};

/** A use's button, 44 px. Off, it looks disabled but keeps its focus and says why (docs/design-v1-combat-controls.md 9). */
function UseButton(props: UseButtonProps) {
  const off = props.off !== undefined && props.off !== null;
  return (
    <>
      <Button
        size="sm"
        aria-label={props.label}
        aria-disabled={off || undefined}
        aria-describedby={off ? props.offId : undefined}
        busy={props.busy}
        onClick={() => (off ? props.onOff?.({ text: props.off!, refused: false }) : props.onClick?.())}
        style={{ flex: "1 1 auto", whiteSpace: "nowrap", ...(off ? { ...buttonLook("secondary", { disabled: true }), cursor: "default" } : null) }}
      >
        {props.text}
      </Button>
      {off ? (
        <span id={props.offId} hidden>
          {props.off}
        </span>
      ) : null}
    </>
  );
}
