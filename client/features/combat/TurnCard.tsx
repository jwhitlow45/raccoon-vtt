import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import type { ClientOp } from "#shared/protocol.ts";
import { reachWords } from "#shared/rules/opportunity.ts";
import { Button } from "../../components/Button.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Loading } from "../../components/Loading.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";
import { AttackRows } from "../dice/RollOptions.tsx";
import { alertCard } from "../encounter/alertCard.ts";
import { useSend } from "../encounter/hooks.ts";
import type { ReactionTarget } from "../encounter/ready.ts";
import { Module } from "../modules/Gate.tsx";
import { blockLoad, type BlockReach, type ReachRowModel, type TurnCardModel } from "./alerts.ts";
import { CombatUses } from "./CombatUses.tsx";

/** The id a turn card has in the alerts column and the dock's summary. */
export function turnAlertId(model: TurnCardModel): string {
  return model.id;
}

/** "Adult Red Dragon's turn". */
export function turnTitle(model: Pick<TurnCardModel, "name">): string {
  return `${model.name}'s turn`;
}

/**
 * "3 uses", the count after the title in the folded row's words, "Adult
 * Red Dragon's turn: 3 uses" (4.2). A creature with attacks counts them
 * first (QOL audit Q1): "Goblin Warrior 1's turn: 2 attacks", "2 attacks,
 * 3 uses". A walk that left an enemy's reach leads, since the notice is
 * the news (docs/design/design-v1-opportunity-attacks.md 1): "left Goblin 2's
 * reach, 2 attacks", "left 3 creatures' reach".
 */
export function turnUsesText(model: Pick<TurnCardModel, "count"> & Partial<Pick<TurnCardModel, "attacks" | "left">>): string {
  const uses = `${model.count} ${model.count === 1 ? "use" : "uses"}`;
  const attacks = model.attacks ?? 0;
  const left = model.left ?? [];
  const attackText = `${attacks} ${attacks === 1 ? "attack" : "attacks"}`;
  const counts = attacks === 0 ? uses : model.count > 0 ? `${attackText}, ${uses}` : attackText;
  if (left.length === 0) return counts;
  const notice = reachWords(left, "left", false, 1);
  return attacks === 0 && model.count === 0 ? notice : `${notice}, ${counts}`;
}

/** The words a block's Opportunity Attacks show, here whole for their tests (section 1). */
export const REACH_WORDS = {
  heading: "Opportunity Attacks",
  used: "Reaction used",
  checking: "Checking the walk…",
  over: "Too many creatures here to check this walk.",
  disengage: (name: string) => `Unless ${name} took the Disengage action.`,
  avoid: (name: string, trait: string) => `${name} has ${trait}, which may avoid them.`,
  unseen: (name: string) => `${name} is Invisible. Creatures that can't see ${name} get no Opportunity Attack.`,
  more: (n: number) => `and ${n} more`,
  fiveFt: (name: string) => `${name} (5 ft counted)`,
} as const;

/** The most rows a block lists, the rest counted after them (D-261128-064). */
export const REACH_ROWS = 8;

/** A row's words: the creature as this viewer reads it, a trait that grants it more Reactions, or the 5 ft a player's device counted. */
export function reachRowText(row: Pick<ReachRowModel, "name" | "fiveFt" | "trait">): string {
  if (row.trait) return row.trait;
  return row.fiveFt ? REACH_WORDS.fiveFt(row.name) : row.name;
}

/** The op a row's Reaction used sends: the tracker row's switch, or a companion's own (encounter/ReactionSection.tsx). */
export function reactionUsedOp(mark: ReactionTarget): ClientOp {
  return mark.kind === "companion" ? { t: "token.update", tokenId: mark.tokenId, patch: { companionReaction: true } } : { t: "encounter.update", entryId: mark.entryId, patch: { reactionUsed: true } };
}

/** A fold's button over its words: the chevron, then the words, the trap card's look (features/traps/TrapCard.tsx), at a touch target's height. */
const FOLD: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: theme.touch,
  display: "flex",
  alignItems: "center",
  gap: theme.space(1),
  padding: 0,
  background: "transparent",
  border: "none",
  color: theme.color.text,
  fontFamily: theme.font.body,
  textAlign: "left",
  cursor: "pointer",
};

/**
 * The turn card (docs/design/design-v1-combat-controls.md 4.2): from a creature's
 * turn start to its end, the turn's menu of its uses, for whoever answers
 * for it, with a block under each other creature of the turn this viewer
 * answers for. On its own turn a creature takes no legendary action, so
 * the card counts its pips and lists no button for them (13.1). A
 * creature's attacks lead each block, its uses under them (QOL audit Q1).
 *
 * `folded` is one 44 px row, "Adult Red Dragon's turn: 3 uses" with Show,
 * which FightAlerts picks under 600 px wide and wherever the card would not
 * stack above a docked bar. Show unfolds it on this device, and Collapse
 * folds it back where it was folded. Dismiss hides it here for this turn.
 */
export function TurnCard(props: { model: TurnCardModel; folded: boolean; foldable: boolean; cardRef?: Ref<HTMLElement>; onShow(on: boolean): void; onDismiss(): void }) {
  const { model } = props;
  const title = turnTitle(model);
  const usesId = useId();
  if (props.folded) {
    return (
      // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
      <section
        ref={props.cardRef}
        role="group"
        aria-label={title}
        tabIndex={-1}
        data-alert="turn"
        data-alert-id={turnAlertId(model)}
        data-turn-folded=""
        style={{ ...alertCard, display: "flex", alignItems: "center", gap: theme.space(2), minHeight: theme.touch, padding: `0 ${theme.space(3)}px` }}
      >
        {/* The fold's chevron leads its words, as the trap card's and every group's does (docs/design/design-v1-icons-2.md 4). Its name keeps "Show", which its words do not say, and the count its label would hide is its description. */}
        <button type="button" aria-expanded={false} aria-label={`Show ${title}`} aria-describedby={usesId} onClick={() => props.onShow(true)} style={FOLD}>
          <Icon name="chevronRight" size="sm" />
          <span style={{ flex: 1, minWidth: 0, fontSize: theme.font.body14, fontWeight: theme.weight.strong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}: <span id={usesId}>{turnUsesText(model)}</span>
          </span>
        </button>
      </section>
    );
  }
  const several = model.blocks.length > 1 || model.blocks.some((b) => !b.participant.landing);
  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      ref={props.cardRef}
      role="group"
      aria-label={title}
      tabIndex={-1}
      data-alert="turn"
      data-alert-id={turnAlertId(model)}
      style={{ ...alertCard, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      {/* The buttons go under a name too long to share their line, rather than squeeze it to a word a line. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(1), minHeight: theme.touch, margin: `-${theme.space(1)}px -${theme.space(1)}px 0 0` }}>
        {props.foldable ? (
          // The fold's chevron leads the title, as the trap card's does. Its name keeps "Collapse", which its words contain.
          <button type="button" aria-expanded aria-label={`Collapse ${title}`} onClick={() => props.onShow(false)} style={{ ...FOLD, flex: "1 1 auto" }}>
            <Icon name="chevronDown" size="sm" />
            <span style={{ flex: 1, minWidth: 0, fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>{title}</span>
          </button>
        ) : (
          <span style={{ flex: "1 1 auto", minWidth: 0, fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>{title}</span>
        )}
        {/* Dismiss is the close every card and sheet draws (docs/design/design-v1-icons-2.md 4). It stays at the top when a long name wraps, rather than floating mid-card (LP34-BAND-1). */}
        <Button size="sm" variant="quiet" icon="close" iconOnly="always" aria-label={`Dismiss ${title}`} onClick={props.onDismiss} style={{ flex: "none", marginLeft: "auto", alignSelf: "flex-start" }} />
      </div>
      {model.blocks.map(({ participant, uses, reach }) => {
        const load = blockLoad(model, uses !== null);
        return (
          <div key={participant.holder} role={several ? "group" : undefined} aria-label={several ? participant.name : undefined} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
            {several ? <div style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>{participant.name}</div> : null}
            {reach.rows.length > 0 || reach.checking || reach.over ? <ReachBlock reach={reach} name={participant.name} announce={reach.announce} /> : null}
            {/* Its results count from the turn's start, so last turn's hit never offers its chips again. While the uses load or failed, their line speaks for both unless the rolls table failed alone. */}
            <AttackRows
              creature={participant.target}
              tokenId={"tokenId" in participant.target ? participant.target.tokenId : undefined}
              name={participant.name}
              after={model.since}
              quietWait={load.attacksQuiet}
            />
            <CombatUses target={participant.target} form="card" uses={uses} loading={load.uses.loading} failed={load.uses.failed} ownTurn name={participant.name} />
          </div>
        );
      })}
    </section>
  );
}

/**
 * A block's Opportunity Attacks (docs/design/design-v1-opportunity-attacks.md 1
 * and 6): a group of that name over the creature's attacks, one row per
 * creature whose reach the turn's walk left, each with Reaction used where
 * this viewer may mark it, and the muted lines that keep it honest. A
 * polite live region in it says each new row once, so a keyboard mover
 * hears it. When a row leaves after its press, focus moves to the next
 * row's button, else the one before, else the card's Collapse, else the
 * card.
 */
function ReachBlock(props: { reach: BlockReach; name: string; announce?: string }) {
  const { reach, name } = props;
  const box = useRef<HTMLDivElement>(null);
  const [pressed, setPressed] = useState<{ id: string; at: number } | null>(null);
  const shown = reach.rows.slice(0, REACH_ROWS);
  const rest = reach.rows.length - shown.length;
  const ids = shown.map((r) => r.id).join("\n");
  useLayoutEffect(() => {
    if (!pressed || shown.some((r) => r.id === pressed.id)) return;
    setPressed(null);
    const root = box.current;
    const active = typeof document === "undefined" ? null : document.activeElement;
    // Only where the press left focus: on the gone button, or on nothing.
    if (!root || (active && active !== document.body && root.contains(active) === false && active.isConnected)) return;
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button[data-reach-used]")];
    const card = root.closest<HTMLElement>('[data-alert="turn"]');
    const next = buttons[pressed.at] ?? buttons[pressed.at - 1] ?? card?.querySelector<HTMLButtonElement>('button[aria-label^="Collapse "]') ?? card;
    next?.focus();
    // The rows' ids stand for the rows, which a new view rebuilds every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, pressed]);
  const muted: CSSProperties = { margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted };
  return (
    <Module id="opportunity">
      <div ref={box} role="group" aria-label={REACH_WORDS.heading} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
        <div style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>{REACH_WORDS.heading}</div>
        {shown.map((row, i) => (
          <ReachRow key={row.id} row={row} onPressed={() => setPressed({ id: row.id, at: i })} />
        ))}
        {rest > 0 ? <p style={muted}>{REACH_WORDS.more(rest)}</p> : null}
        <Loading text={REACH_WORDS.checking} active={reach.checking} small />
        {reach.over ? <p style={muted}>{REACH_WORDS.over}</p> : null}
        {reach.rows.length > 0 ? <p style={muted}>{REACH_WORDS.disengage(name)}</p> : null}
        {reach.rows.length > 0 && reach.avoid ? <p style={muted}>{REACH_WORDS.avoid(name, reach.avoid)}</p> : null}
        {reach.rows.length > 0 && reach.unseen ? <p style={muted}>{REACH_WORDS.unseen(name)}</p> : null}
        <div aria-live="polite" style={VISUALLY_HIDDEN}>
          {props.announce ?? ""}
        </div>
      </div>
    </Module>
  );
}

/** One creature's row: the combat icon, its name wrapping beside its Reaction used, which goes under the name where both do not fit. */
function ReachRow(props: { row: ReachRowModel; onPressed(): void }) {
  const { row } = props;
  const send = useSend();
  const words = reachRowText(row);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), minHeight: theme.touch }}>
      <span style={{ flex: "1 1 10em", minWidth: 0, display: "flex", alignItems: "center", gap: theme.space(1), fontSize: theme.font.body14, lineHeight: theme.leading.body, color: theme.color.text }}>
        <Icon name="combat" size="sm" style={{ flex: "none", color: theme.color.textMuted }} />
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{words}</span>
      </span>
      {row.mark ? (
        <Button
          size="sm"
          variant="secondary"
          busy={send.waiting}
          data-reach-used=""
          aria-label={`${REACH_WORDS.used}: ${words}`}
          onClick={() => {
            props.onPressed();
            send.send(reactionUsedOp(row.mark!));
          }}
          style={{ flex: "none" }}
        >
          {REACH_WORDS.used}
        </Button>
      ) : null}
    </div>
  );
}
