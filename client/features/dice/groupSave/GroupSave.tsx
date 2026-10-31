import { useEffect, useId, useMemo, useRef, useState } from "react";
import { bonusFor } from "#shared/dice/bonus.ts";
import type { AdvantageSource } from "#shared/dice/formula.ts";
import { uuidv7 } from "#shared/ids.ts";
import { ABILITY_KEYS, CONDITION_KEYS, SKILL_KEYS, type AbilityKey, type ConditionKey, type Effect, type RoomState, type SkillKey } from "#shared/model.ts";
import type { ActorTarget, OpOf } from "#shared/protocol.ts";
import { DAMAGE_TYPES, damageTypeName, type DamageType } from "#shared/rules/damage.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { effectName } from "#shared/logText.ts";
import { DamageSummary } from "../DamageSummary.tsx";
import { damageSummary, type DamageSummaryLines } from "../damageSummaryLines.ts";
import { Button, type ButtonProps } from "../../../components/Button.tsx";
import { Checkbox } from "../../../components/Checkbox.tsx";
import { Chip, ChipRow } from "../../../components/Chip.tsx";
import { Input } from "../../../components/Field.tsx";
import { Notice } from "../../../components/Notice.tsx";
import { ProficiencyLabel } from "../../../components/ProficiencyMark.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { stickyPaneFoot } from "../../../components/Sheet.tsx";
import { Section } from "../../../components/Panel.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import { useRollModeMenu } from "../useRollModeMenu.tsx";
import { rollModeTo, resolveRollMode, type RollModeOverride, type RollModeCapability } from "../rollMode.ts";
import { usePanelHeader } from "../../panels.ts";
import { EffectPicker } from "../../tokens/EffectsSection.tsx";
import { SaveEndsFields, type SaveEndsForm } from "../../tokens/SaveEndsFields.tsx";
import { FieldRow, Note, NumberField, Select, Stepper } from "../../tokens/ui.tsx";
import { limitedUses } from "#shared/dice/uses.ts";
import { actorOf } from "../../combat/logic.ts";
import { creatureBlock, creatureProficiency, creatureRolls } from "../creature.ts";
import { creatureKey, holderTarget, markOnRoll, rechargeUseOf, signedText, targetRef, spendsFor } from "../options.ts";
import { presetFor } from "../presets.ts";
import { marksTest } from "../proficiencyPresentation.ts";
import { useRollSender } from "../send.ts";
import { useDicePanel, type PanelRoll } from "../useDicePanel.ts";
import { useDiceView } from "../useDiceView.ts";
import { SrdLoadFailed } from "../../monsters/SrdLoadFailed.tsx";
import { useReceipt, type ReceiptState } from "../useReceipt.ts";
import { useRollBlocked } from "../useRollOption.ts";
import { d20Text, informativeRollMode, RollResultLine, knownOrTyped, parseBonus, requestRollSource } from "../../rolls/card.ts";
import {
  newPage,
  applyAgain,
  castEndOf,
  castSeen,
  closeSettled,
  closeTheAsk,
  mayApplyAgain,
  askAnswered,
  damageSent,
  discard,
  dmRoll,
  dmRollSettled,
  mark,
  markGone,
  results,
  roll,
  rollAgain,
  rollWords,
  setAmount,
  setDc,
  followSelection,
  settleTag,
  publicName,
  sourceIds,
  stateOf,
  syncRequests,
  typeTotal,
  waitingTags,
  type Command,
  type Settled,
  type Page,
  type ServerRoll,
  type Step,
} from "./chain.ts";
import { parseParts } from "./outcome.ts";
import { amountsOf, applyWaits, applyWords, buildPlan, damageTo, NOTHING_TO_APPLY, openSaveState, pageBound, rowOutcome, rowWords, SETTLE_WORDS } from "./plan.ts";
import { countWords, creatureCount, d20Of, groupRows, rowBonus, type GroupTest, type Mark, type RowBase, type RowState, type Way } from "./rows.ts";
import { useGroupSave, useGroupSaveStore } from "./store.ts";
import { actionFill, areaFill, casterActions } from "./fills.ts";
import { castFill } from "../cast/castStart.ts";
import { sentAny } from "./start.ts";
import { parseDamageOverride } from "./damageInput.ts";
import { Loading } from "../../../components/Loading.tsx";
import { saveRechargeSpendSchema } from "#shared/saveOutcomeContract.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { prepareSave, reconcileSave, resumeSaveEdits, saveEditable, SAVE_MEMORY_ONLY, OUTCOME_UNAVAILABLE, type SaveSession } from "./reopen.ts";
import { authorityOf } from "./lifecycle.ts";
import { askAgain, rerollSaves } from "./reroll.ts";

export function RowDamageField(props: { name: string; value: number | string | undefined; computed: number | null; summary?: DamageSummaryLines; onChange(value: string | null): void }) {
  const errorId = useId();
  const parsed = props.value === undefined ? null : parseDamageOverride(props.value);
  const error = parsed?.ok === false ? parsed.error : null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), alignItems: "center" }}>
        <Input aria-label={`${props.name}'s damage`} inputMode="text" value={props.value ?? ""} placeholder={props.computed === null ? "10 fire" : `${props.computed} or 10 fire`} autoComplete="off" error={error !== null} aria-describedby={error ? errorId : undefined} onChange={(e) => props.onChange(e.target.value)} style={{ flex: "1 1 160px", width: 160 }} />
        {props.value !== undefined ? <Button size="sm" onClick={() => props.onChange(null)}>{props.computed === null ? "Clear override" : `Back to ${props.computed}`}</Button> : null}
      </div>
      {!error && (props.summary || parsed?.ok) ? <DamageSummary summary={props.summary ?? damageSummary(parsed?.ok ? parsed.parts ?? [{ amount: parsed.amount }] : [])} /> : null}
      {error ? <span id={errorId} role="status" style={{ fontSize: theme.font.small, color: theme.color.dangerText }}>{error}</span> : null}
    </div>
  );
}

/**
 * The group save (docs/design-v1-roll-options.md 5): rows rolled by the
 * server, asked, typed or failing outright, pass or fail against the DC,
 * then the outcome, each row overridable, and one Apply the server applies
 * as one op and one undo. A page of the Dice panel or of the Areas panel,
 * on the DM's device only. All its rules are chain.ts, rows.ts, outcome.ts
 * and plan.ts: this sends what they return and shows what they hold.
 */

const WAY_WORDS: Record<Way, string> = { fails: "Fails", ask: "Ask", server: "Server", type: "Type" };

/** The bonus the DM types for a row with no stat block that rolls on the server (rows.ts rowBonus). */
function RowBonusField(props: { name: string; value: number | undefined; onChange(bonus: number | undefined): void }) {
  // The field starts as the DM would type it, with a keyboard's hyphen, as every typed bonus reads.
  const [text, setText] = useState(props.value === undefined ? "" : props.value < 0 ? `${props.value}` : `+${props.value}`);
  const typed = parseBonus(text);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
      <Input
        aria-label={`Bonus for ${props.name}`}
        value={text}
        placeholder="+0"
        enterKeyHint="done"
        autoComplete="off"
        maxLength={3}
        error={typed?.ok === false}
        onChange={(e) => {
          setText(e.target.value);
          const next = parseBonus(e.target.value);
          props.onChange(next?.ok ? next.bonus : undefined);
        }}
        style={{ width: 64, flex: "none", textAlign: "center" }}
      />
      <span style={{ fontSize: theme.font.small, color: typed?.ok === false ? theme.color.dangerText : theme.color.textMuted }}>{typed?.ok === false ? typed.error : "No stat block: type its bonus."}</span>
    </div>
  );
}

/** The server way's words: "Server +5", and for a creature with no stat block "Server d20", then "Server d20+3" once a bonus is typed. */
function serverWords(row: RowBase, s: RowState): string {
  if (row.bonus !== null) return `Server ${signedText(row.bonus)}`;
  return s.typedBonus !== undefined ? `Server ${d20Text(s.typedBonus)}` : "Server d20";
}
const MARKS: readonly { value: Mark; label: string }[] = [
  { value: "fail", label: "Fail" },
  { value: "pass", label: "Pass" },
  { value: "skip", label: "Skip" },
];

/** The page's title: "Fireball's save", "Dexterity save for 6". */
export function pageTitle(page: Pick<Page, "fill" | "test" | "rows" | "source">): string {
  if (page.fill) return page.test.kind === "none" ? page.fill.name : `${page.fill.name}'s ${page.test.kind}`;
  const n = page.rows.length || (page.source.kind === "selection" ? page.source.tokenIds.length : 0);
  if (page.test.kind === "none") return `Damage for ${n}`;
  const what = page.test.kind === "save" ? `${ABILITY_NAMES[page.test.ability]} save` : page.test.skill ? `${SKILLS[page.test.skill].name} check` : `${ABILITY_NAMES[page.test.ability]} check`;
  return `${what} for ${n}`;
}

export function GroupSave(props: { parent: "Dice" | "Areas"; onBack(): void; areaIds?: (templateId: string) => string[] }) {
  const store = useGroupSaveStore();
  const page = useGroupSave((s) => s.page);
  if (!page) return null;
  return <GroupSavePage page={page} parent={props.parent} onBack={props.onBack} set={(p) => store.setState({ page: p })} {...(props.areaIds ? { areaIds: props.areaIds } : {})} />;
}

function GroupSavePage(props: { page: Page; parent: "Dice" | "Areas"; onBack(): void; set(page: Page | null): void; areaIds?: (templateId: string) => string[] }) {
  const { page, set } = props;
  const groupStore = useGroupSaveStore();
  const roomStore = useRoomStore();
  const reopen = useGroupSave(s => s.reopen);
  const confirmedRoom = () => roomStore.getState().you?.role === "dm" ? roomStore.getState().confirmed as RoomState | null | undefined : null;
  const currentSession = (): SaveSession => ({ page: groupStore.getState().page ?? pageRef.current, reopen: groupStore.getState().reopen });
  const roomId = useRoomView((s) => s.roomId);
  const viewing = useRoomView((s) => s.sceneId);
  const view = useRoomView((s) => s.view);
  // The DM projection contains complete actors. Never substitute the predicted view here.
  const confirmedView = useRoomView((s) => s.you?.role === "dm" ? s.confirmed as RoomState | null | undefined : null);
  const me = useRoomView((s) => s.you?.memberId ?? "");
  const actions = useRoomActions();
  const ui = useRoomUi();
  const panel = useDicePanel();
  const sender = useRollSender();
  const blocked = useRollBlocked();
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmStartOver, setConfirmStartOver] = useState(false);
  const [seenOpen, setSeenOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(page.phase === "setup");
  const pageRef = useRef(page);
  pageRef.current = page;
  const update = (next: Page) => {
    const active = groupStore.getState().page;
    if (!active || active.id !== next.id) return;
    const prev = active;
    // A roll belongs to the parts it rolled: new parts drop it, so its amounts never land on parts it did not roll.
    const checked = next.outcome.damage !== prev.outcome.damage && next.damage !== null && next.damage === prev.damage ? { ...next, damage: null } : next;
    pageRef.current = checked;
    set(checked);
  };

  const editableNow = () => {
    const current = currentSession();
    if (roomStore.getState().connection !== "open" || current.page.phase === "applying" || current.page.phase === "applied") return false;
    return current.reopen?.tracking || current.reopen?.check ? saveEditable(current, authorityOf(roomStore.getState(), current.page)) : true;
  };
  const edit = (next: Page) => { if (editableNow()) update(next); };
  const lifecycleLocked = !!reopen?.check && reopen.check !== "undone";
  const frozen = page.phase === "applying" || page.phase === "applied" || lifecycleLocked || blocked !== null;

  const selected = useRoomView((s) => s.local.selectedIds);
  const fromSource = sourceIds(page.source, selected, props.areaIds);
  // The picks go into the page, and so into the draft, as the selection changes.
  useEffect(() => {
    const next = followSelection(pageRef.current, selected);
    if (next !== pageRef.current) update(next);
  }, [selected.join(","), page.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const ids = page.phase === "setup" ? fromSource : page.rows.map((r) => r.tokenId);
  const creatures = useMemo<ActorTarget[]>(() => ids.map((tokenId) => ({ tokenId })), [ids.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const { dice, loading, failed } = useDiceView(creatures);
  // Apply reads the recharge a fill came from in its creature's block, which loads with the page too, as after a reload (rechargeSpend). The SRD's blocks are one store, so `dice` reads them once loaded.
  const rechargeHolder = page.fill?.recharge?.holder;
  const casters = useMemo(() => {
    const caster = rechargeHolder ? holderTarget(rechargeHolder) : null;
    return caster ? [caster] : [];
  }, [rechargeHolder]);
  useDiceView(casters);
  const live = dice && page.phase === "setup" ? groupRows(dice, fromSource, page.test, page.spell) : page.rows;
  const rows = live;
  const tooMany = rows.length > 100;
  const shown: Page = page.phase === "setup" ? { ...page, rows } : page;
  const pageTest = d20Of(page.test, page.spell);
  const key = (t: { tokenId?: string; characterId?: string }) => (view ? creatureKey(view, t) : "");

  // Answers come from the requests in the view (5.3), and creatures that left are marked gone, after the roll.
  useEffect(() => {
    if (!confirmedView || page.phase === "setup") return;
    let next = syncRequests(pageRef.current, confirmedView.rolls, t => creatureKey(confirmedView, t));
    next = markGone(next, viewing, (row) => confirmedView.tokens[row.tokenId] !== undefined);
    if (next !== pageRef.current) update(next);
  }, [confirmedView?.rolls, confirmedView?.tokens, viewing, page.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // A player's ask the page holds, as the view holds it (docs/design-v1-player-save-spell.md 3.3): its end, read from its closing line, frees or stops Apply.
  useEffect(() => {
    const cast = pageRef.current.cast;
    if (!confirmedView || !cast) return;
    const id = cast.ask.id;
    const next = castSeen(pageRef.current, confirmedView.casts[id] ? { present: true } : { present: false, end: castEndOf(confirmedView.log, id) });
    if (next !== pageRef.current) update(next);
  }, [confirmedView?.casts, confirmedView?.log, page.phase, page.apply, page.cast?.ask.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = pageTitle(shown);
  usePanelHeader({ title, parent: props.parent, onBack: props.onBack });
  const rollNowRef = useRef<() => void>(() => undefined);
  // A quick tap waits for the stat blocks, so a monster whose bonus is still loading is never left to be typed.
  const ready = view !== null && dice !== null && rows.length > 0 && !loading;
  useEffect(() => {
    if (ready && page.phase === "setup" && page.rollNow) rollNowRef.current();
  }, [ready, page.phase, page.rollNow]);
  if (!view || !dice) return <Note>Loading the creatures…</Note>;

  const offScene = page.sceneId !== viewing || !view.scenes[page.sceneId];
  const sceneName = view.scenes[page.sceneId]?.name ?? "another scene";
  const fillType = page.fill?.damageType;
  const amounts = amountsOf(shown, fillType);
  const outcomes = new Map(rows.map((r) => [r.holder, rowOutcome(shown, r, dice, amounts)]));
  const outcomeList = [...outcomes.values()];
  const count = countWords(rows.filter((r) => stateOf(shown, r).mark !== "skip").map((r) => outcomes.get(r.holder)!.result));
  const conditions = page.outcome.conditions as ConditionKey[];
  const bound = pageBound(shown, rows);
  const parsedParts = page.outcome.damage.trim() ? parseParts(page.outcome.damage, fillType) : null;

  /** Takes a step of the page and sends its commands. True when something went. */
  const run = (step: Step): boolean => {
    if (step.error) {
      setError(step.error);
      return false;
    }
    setError(null);
    update(step.page);
    send(step.send);
    return step.send.length > 0;
  };

  const send = (commands: readonly Command[]) => {
    for (const c of commands) {
      if (c.kind === "dice") panel.roll(c.rolls, { to: c.to, tag: c.tag, ...(c.dc !== undefined ? { dc: c.dc } : {}) });
      else if (c.kind === "outcome") sendOutcome(c.op);
      else if (c.op.t === "roll.ask") {
        const rollId = c.op.request.id;
        const n = actions.dispatch(c.op, {
          quiet: true,
          onAnswer: (answer, refusal) => {
            const active = groupStore.getState().page;
            if (!active || active.id !== page.id) return;
            let next = answer === "taken" ? askAnswered(active, rollId, { ok: true }) : answer === "refused" ? askAnswered(active, rollId, { ok: false, message: refusal?.text ?? refusal?.message ?? "the request was refused" }) : active;
            const confirmed = confirmedRoom();
            if (confirmed) next = syncRequests(next, confirmed.rolls, t => creatureKey(confirmed, t));
            update(next);
          },
        });
        if (n === null) update(askAnswered(groupStore.getState().page ?? pageRef.current, rollId, { ok: false, message: "Not sent." }));
      } else if (c.op.t === "roll.dice") {
        // The DM's tap on an asked row is settled by its receipt, as the page's other rolls are, so a reload in between settles it too.
        const tag = c.op.tag;
        sender.receipts.sending(tag, 0);
        const n = actions.dispatch(c.op, { quiet: true, onAnswer: (answer, refusal, cause) => sender.receipts.answer(tag, 0, answer, refusal, cause) });
        if (n === null) {
          sender.receipts.forget(tag, 0);
          update(dmRollSettled(pageRef.current, tag, "refused", "Not sent."));
        }
      } else if (c.op.t === "cast.close") {
        // The close has no receipt: its answer settles the page, and a reload leaves it to the view (restoredPage).
        const n = actions.dispatch(c.op, {
          quiet: true,
          onAnswer: (answer, refusal) =>
            update(
              closeSettled(
                pageRef.current,
                answer === "taken" ? { state: "taken" } : answer === "refused" ? { state: "refused", says: refusal?.text || refusal?.message || "The close was refused.", ...(refusal?.message ? { message: refusal.message } : {}) } : { state: "unknown" },
              ),
            ),
        });
        if (n === null) update(closeSettled(pageRef.current, { state: "refused", says: "Not sent." }));
      } else actions.dispatch(c.op);
    }
  };

  // The outcome is tagged by its plan (doc 1 1.2): its receipt settles it, and only the DM's Apply again sends it again.
  const sendOutcome = (op: NonNullable<Page["plan"]>) => {
    sender.receipts.sending(op.plan, 0);
    const n = actions.dispatch(op, { quiet: true, onAnswer: (answer, refusal, cause) => sender.receipts.answer(op.plan, 0, answer, refusal, cause) });
    if (n === null) sender.receipts.answer(op.plan, 0, "refused", { code: "invalid", message: "Not sent.", text: "Not sent." });
  };

  const serverRolls = (holders: readonly RowBase[]): ServerRoll[] => {
    const d20 = d20Of(page.test, page.spell);
    if (!d20) return [];
    return holders.flatMap((r) => {
      const rolls = creatureRolls(dice, r.target);
      const bonus = (rolls?.numbers ? bonusFor(rolls.numbers, d20) : null) ?? stateOf(pageRef.current, r).typedBonus ?? null;
      if (bonus === null) return [];
      const preset = presetFor(dice, r.target, d20, { rolls });
      return [{ holder: r.holder, target: r.target, bonus, sources: preset.sources, extra: preset.extra }];
    });
  };

  const startRoll = (given?: AdvantageSource[], override?: RollModeOverride) => {
    if (!editableNow() || blocked || offScene || loading) return;
    if (bound) {
      setError(bound);
      return;
    }
    // A quick roll keeps the choices captured before replacement confirmation. A menu pick only reads the current choices.
    const taken = given ? { sources: given, restore: () => undefined } : override ? panel.peek() : panel.take();
    const step = roll(pageRef.current, { rows, server: serverRolls(rows), tag: uuidv7(), requestIds: () => actions.newId(), openRequests: Object.keys(view.rolls).length, taken: taken.sources, at: new Date().toISOString(), ...(override ? { override } : {}) });
    if (step.error) taken.restore();
    run(step);
    setOutcomeOpen(false);
  };

  rollNowRef.current = () => {
    const sources = pageRef.current.rollNow?.sources ?? [];
    // Once only: a refusal leaves the page in setup without the flag, for the DM's own Roll.
    const { rollNow: _done, ...rest } = pageRef.current;
    pageRef.current = rest;
    startRoll(sources);
  };

  const rollDamage = (override?: RollModeOverride) => {
    if (!editableNow() || blocked || offScene) return;
    if (page.phase === "applying" || page.phase === "applied" || pageRef.current.damage?.state === "sending") return;
    const { rolls: rollsToSend, to } = groupDamageInvocation(pageRef.current, view, override);
    if (rollsToSend.length === 0) return;
    const tag = uuidv7();
    if (panel.roll(rollsToSend, { to, tag }) !== null) update(damageSent(pageRef.current, tag));
  };

  const doApply = () => {
    const active = currentSession();
    const authority = authorityOf(roomStore.getState(), active.page);
    if (!saveEditable(active, authority) || blocked || loading) return;
    let current = active.page.phase === "setup" ? { ...active.page, rows } : active.page;
    const confirmed = confirmedRoom();
    if (!confirmed) return;
    current = markGone(current, roomStore.getState().sceneId, row => confirmed.tokens[row.tokenId] !== undefined);
    const currentDice = { ...dice, view: confirmed };
    const currentAmounts = amountsOf(current, current.fill?.damageType);
    const waits = applyWaits(current, currentDice, currentAmounts);
    if (waits) { setError(waits); return; }
    const plan = buildPlan(current, currentDice, currentAmounts, { plan: uuidv7(), newId: actions.newId });
    if (!plan) {
      if (current.cast) closeAsk();
      else setError("Nothing would change.");
      return;
    }
    const spend = rechargeSpend(current.fill?.recharge);
    const recharge = spend ? saveRechargeSpendSchema.safeParse({ target: spend.target, use: { kind: "ability", key: spend.use.key, name: spend.use.name, limit: "recharge", max: 1, min: spend.use.min, ifReady: true }, ...(damageTo(current, confirmed) === "dm" ? { quiet: true } : {}) }) : null;
    if (recharge && !recharge.success) { setError("This recharge ability could not be checked."); return; }
    const op = recharge?.success ? { ...plan, recharge: recharge.data } : plan;
    const step = prepareSave({ ...active, page: current }, op, authority);
    if (step.error) { setError(step.error); return; }
    const outcome = step.send.find(command => command.kind === "outcome");
    if (outcome && serializedBytes(outcome.op) > LIMITS.outcomeOpBytes) { setError("That outcome is too large. Use fewer creatures or conditions."); return; }
    // Publish the checkpoint synchronously before any request close or outcome.
    pageRef.current = step.page;
    groupStore.setState({ page: step.page, reopen: step.reopen });
    setError(null);
    send(step.send);
  };

  /**
   * The recharge a fill came from, as its holder's use where this device
   * shows it ready: its name and range from that creature's block, else its
   * roll. None once the creature no longer has the roll.
   */
  const rechargeSpend = (from: { holder: string; key: string } | undefined) => {
    const target = from ? holderTarget(from.holder) : null;
    const confirmed = confirmedRoom();
    if (!from || !target || !confirmed || !spendsFor(confirmed, dice.you, target)) return null;
    const confirmedDice = { ...dice, view: confirmed };
    const named = creatureRolls(confirmedDice, target)?.named.find((r) => r.key === from.key);
    const block = creatureBlock(confirmedDice, target);
    const use = markOnRoll(named ? rechargeUseOf(named, block ? limitedUses(block) : null) : null, actorOf(confirmed, target)?.uses);
    return use ? { target, use } : null;
  };

  // Close the ask (3.3): where Apply would change nothing, the ask closes as done, with the page's open requests first.
  const closeAsk = () => {
    if (!editableNow() && !pageRef.current.cast?.closing || blocked || offScene) return;
    const base = page.phase === "setup" ? { ...pageRef.current, rows } : pageRef.current;
    run(closeTheAsk(base));
  };

  const close = () => {
    send(discard(page));
    groupStore.setState({ page: null, reopen: null });
    props.onBack();
  };

  const rolledAny = sentAny(page);
  const doneWords =
    page.apply === "taken"
      ? page.plan
        ? page.plan.targets.length > 0
          ? `Applied to ${page.plan.targets.length}. Undo takes it all back.`
          : "Settled: it changed no one. Undo brings its card back."
        : page.cast
          ? `Closed ${page.cast.who}'s ask for saves.`
          : null
      : null;

  const doReroll = (holders: string[]) => {
    if (!editableNow() || blocked || offScene) return;
    const confirmed = confirmedRoom();
    if (!confirmed) return;
    const current = pageRef.current;
    const ask = askAgain(current, { holders, requests: confirmed.rolls, requestIds: actions.newId });
    if (ask.error) { setError(ask.error); return; }
    const saves = rerollSaves(ask.page, { holders, server: serverRolls(rows), tag: uuidv7() });
    if (saves.error) { setError(saves.error); return; }
    run({ page: saves.page, send: [...ask.send, ...saves.send] });
  };

  const startOver = () => {
    const held = groupStore.getState();
    const current = held.page;
    if (!current || current.id !== page.id || blocked) return;
    if (current.phase === "applying" && (held.reopen?.check !== "unavailable" || roomStore.getState().pending.some(pending => pending.op.t === "actor.outcome" && pending.op.plan === current.plan?.plan))) return;
    send(discard(current));
    const source = current.source.kind === "selection" ? { ...current.source, live: true as const } : current.source;
    const next = newPage({ id: uuidv7(), sceneId: current.sceneId, source, test: current.test, dc: current.dc, secret: current.secret, spell: current.spell, switches: current.switches, fill: current.fill, outcome: current.outcome, ...(current.cast && !current.cast.blocked ? { cast: current.cast } : {}) });
    pageRef.current = next;
    groupStore.setState({ page: next, reopen: null });
    setConfirmStartOver(false);
    setOutcomeOpen(true);
  };

  // ---- the parts

  const setupControls = page.phase === "setup" ? <TestPicker page={page} onChange={edit} /> : null;
  const dcRow = (
    <FieldRow label="DC">
      <NumberField label="DC" value={page.dc ?? undefined} min={1} max={50} nullable placeholder="None" onCommit={(dc) => edit(setDc(pageRef.current, dc))} width={88} />
    </FieldRow>
  );
  const anyAsk = rows.some((r) => stateOf(shown, r).way === "ask");
  // Open server rolls carry the DC only when players may see it (chain.ts diceEnvelope), so the switch shows for them too.
  const openRolls = !page.secret && rows.some((r) => stateOf(shown, r).way === "server");
  const switches =
    page.phase === "setup" ? (
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <Switch label="Hide the monsters' rolls from players" help="Their damage too, unless a player's creature cast it." checked={page.secret} onChange={(secret) => update({ ...pageRef.current, secret })} />
        {page.test.kind === "save" ? <Switch label="Against a spell" help="A creature with Magic Resistance rolls with Advantage, asked or not." checked={page.spell} onChange={(spell) => update({ ...pageRef.current, spell })} /> : null}
        {anyAsk || (openRolls && page.dc !== null) ? (
          // The request sheet's fold and words (LP7-PC-10): a chevron, and folded, what players will see.
          <Section
            label="What players see"
            divider={false}
            fold={{
              open: seenOpen,
              onToggle: () => setSeenOpen((v) => !v),
              summary: <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>{groupSeen(page.dc !== null && page.switches.dcShown, page.dc !== null, anyAsk && page.switches.resultShown)}</span>,
            }}
          >
            {page.dc !== null ? <Checkbox checked={page.switches.dcShown} onChange={(dcShown) => update({ ...pageRef.current, switches: { ...pageRef.current.switches, dcShown } })} label="Players see the DC" /> : null}
            {anyAsk ? <Checkbox checked={page.switches.resultShown} onChange={(resultShown) => update({ ...pageRef.current, switches: { ...pageRef.current.switches, resultShown } })} label="Players see pass or fail" /> : null}
          </Section>
        ) : null}
      </div>
    ) : null;

  const outcomeSummary = `${page.outcome.damage.trim() || "No damage"}${page.outcome.damage.trim() ? `, ${page.outcome.onPass === "half" ? "half" : "none"} on a pass` : ""}${conditions.length > 0 ? `, ${conditions.map(effectName).join(", ")} on a fail` : ""}.`;
  const outcome = (
    <OutcomePanel
      page={page}
      open={outcomeOpen || page.phase === "setup"}
      summary={outcomeSummary}
      onOpen={() => setOutcomeOpen(true)}
      onChange={edit}
      onRoll={rollDamage}
      blocked={blocked !== null || offScene}
      locked={lifecycleLocked}
      picking={picking}
      setPicking={setPicking}
      parsed={parsedParts}
      view={view}
      me={me}
      onSlot={
        page.cast && page.outcome.slot !== undefined
          ? (slot) => {
              const cast = pageRef.current.cast;
              if (!cast) return;
              // A slot change refills the formula from the fill and drops the caster's roll, as a new formula would (3.3).
              const filled = castFill(dice, cast.ask, slot, { imported: false }).input;
              const current = pageRef.current;
              update({ ...current, fill: filled.fill, outcome: { ...current.outcome, damage: filled.outcome.damage ?? "", slot: filled.outcome.slot ?? slot }, damage: current.damage?.imported ? null : current.damage });
            }
          : page.source.kind === "area" && page.outcome.slot !== undefined
          ? (slot) => {
              const template = view.templates[(page.source as { templateId: string }).templateId];
              const filled = template ? areaFill(dice, template, slot) : null;
              // The fill holds the slot at the spell's own level or above, so the stepper never reads a slot it cannot be cast with (5.4).
              if (filled) update({ ...pageRef.current, fill: filled.fill, outcome: { ...pageRef.current.outcome, damage: filled.outcome.damage ?? "", slot: filled.outcome.slot ?? slot } });
            }
          : undefined
      }
    />
  );
  const fillFrom =
    page.phase === "setup" && page.source.kind === "area"
      ? casterActions(dice, view.templates[page.source.templateId] ?? {}).map((named) => (
          <Button
            key={named.key}
            size="sm"
            onClick={() => {
              const casterId = view.templates[(page.source as { templateId: string }).templateId]?.casterId;
              const filled = actionFill(dice, named, { key: casterId ? `t:${casterId}` : "", ...(casterId ? { tokenId: casterId } : {}) });
              if (filled) update({ ...pageRef.current, test: filled.test, dc: filled.dc, spell: filled.spell, fill: filled.fill, outcome: { ...pageRef.current.outcome, ...filled.outcome } });
            }}
          >
            {`Fill from ${named.name}`}
          </Button>
        ))
      : [];

  const rollContext = [page.id, page.sceneId, page.phase, page.test, page.spell, page.dc, page.secret, page.fill, page.switches];
  const rowSources = new Map(rows.map((row) => {
    const state = stateOf(shown, row);
    const request = state.asked ? view.rolls[state.asked.rollId] : undefined;
    const answer = request?.targets.find((target) => JSON.stringify(targetRef(target)) === JSON.stringify(row.askRef));
    return [row.holder, JSON.stringify([rollContext, row, state, serverRolls([row]), page.dmRolls.filter((r) => r.holder === row.holder), request && answer && requestRollSource(request, answer)])];
  }));
  const hasServerRoll = rows.some((r) => !r.skip && stateOf(shown, r).mark !== "skip" && stateOf(shown, r).way === "server");
  const rowList = (
    <div role="group" aria-label="Creatures" style={{ display: "grid", gap: theme.space(1) }}>
      {/*
       * The count takes the line's spare room, so All fail and All pass keep
       * their own width beside it. Where the two do not fit beside it they
       * wrap as a pair and grow to share their line (docs/design-v1-polish.md
       * R6), so neither stands alone under the other.
       */}
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        <span style={{ fontWeight: theme.weight.strong, flex: "999 1 0%", fontVariantNumeric: "tabular-nums" }}>{page.phase === "setup" && page.test.kind !== "none" ? creatureCount(rows.length) : count}</span>
        <span style={{ flex: "1 1 auto", display: "flex", gap: theme.space(2) }}>
          <Button size="sm" style={{ flex: "1 1 auto" }} disabled={page.phase === "applying" || page.phase === "applied" || lifecycleLocked} onClick={() => update(rows.reduce((p, r) => (stateOf(p, r).mark === "skip" && r.skip ? p : mark(p, r.holder, "fail")), { ...pageRef.current, rows } as Page))}>
            All fail
          </Button>
          <Button size="sm" style={{ flex: "1 1 auto" }} disabled={page.phase === "applying" || page.phase === "applied" || lifecycleLocked} onClick={() => update(rows.reduce((p, r) => (stateOf(p, r).mark === "skip" && r.skip ? p : mark(p, r.holder, "pass")), { ...pageRef.current, rows } as Page))}>
            All pass
          </Button>
        </span>
      </div>
      {tooMany ? <Note tone="error">At most 100 creatures in one group save.</Note> : null}
      {rows.length === 0 ? <Note>Select the creatures it hits, or place an area from it.</Note> : null}
      {rows.map((row) => (
        <GroupRow
          key={row.holder}
          page={shown}
          source={rowSources.get(row.holder)!}
          row={row}
          level={dice && marksTest(pageTest) ? creatureProficiency(dice, row.target, pageTest) : undefined}
          outcome={outcomes.get(row.holder)!}
          loading={loading && row.bonus === null}
          blocked={blocked ?? (lifecycleLocked ? "Wait for this save's confirmed state." : offScene ? "Go back to the scene first." : null)}
          onChange={(next) => edit(page.phase === "setup" ? { ...next, rows: pageRef.current.rows } : next)}
          onDmRoll={(typed, override) => {
            if (!editableNow() || blocked || offScene) return;
            const s = stateOf(page, row);
            const d20 = d20Of(page.test, page.spell);
            if (!s.asked || !d20 || !row.askRef) return;
            const preset = presetFor(dice, row.target, d20);
            const op: OpOf<"roll.dice"> = {
              t: "roll.dice",
              tag: uuidv7(),
              rollId: s.asked.rollId,
              target: row.askRef,
              unanswered: true,
              ...(preset.extra.length > 0 ? { extra: preset.extra.join("").replace(/^\+/, "") } : {}),
              ...(typed !== undefined ? { bonus: typed } : {}),
              ...resolveRollMode(preset.sources, [], override),
            };
            run(dmRoll(pageRef.current, row.holder, op));
          }}
          reopened={reopen?.check === "undone"}
          onAskAgain={() => doReroll([row.holder])}
          onRollAgain={(override) => {
            if (!editableNow() || blocked || offScene) return;
            run((reopen?.check === "undone" ? rerollSaves : rollAgain)(pageRef.current, { holders: [row.holder], server: serverRolls([row]), tag: uuidv7(), ...(override ? { override } : {}) }));
          }}
        />
      ))}
    </div>
  );

  const waits = page.phase === "applied" ? null : applyWaits(shown, dice, amounts);
  const words = applyWords(outcomeList, conditions);
  const applyButton =
    page.phase === "applied" ? (
      <div style={{ display: "grid", gap: theme.space(1) }}>
        {/* A page Redo locked again has no plan of its own to name, and an empty line would push Done off its foot's middle. */}
        {doneWords ? <Note tone="info">{doneWords}</Note> : null}
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </div>
    ) : page.apply === "unknown" ? (
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <Note tone="error">This may have happened. Check the log.</Note>
        {mayApplyAgain(page, Date.now()) ? (
          <Button variant="primary" onClick={() => run(applyAgain(pageRef.current))} disabled={blocked !== null}>
            Apply again
          </Button>
        ) : null}
        {page.cast?.closing ? (
          <Button variant="primary" onClick={closeAsk} disabled={blocked !== null}>
            Close the ask
          </Button>
        ) : null}
      </div>
    ) : (
      <Button variant="primary" busy={page.apply === "sending"} disabled={frozen || offScene || waits !== null || bound !== null || tooMany || page.cast?.blocked !== undefined} onClick={doApply}>
        {waits ?? bound ?? (words !== NOTHING_TO_APPLY ? words : page.cast ? "Close the ask" : page.source.kind === "trap" ? SETTLE_WORDS : words)}
      </Button>
    );

  return (
    <div data-save-lifecycle={reopen?.check ?? "draft"} style={{ display: "grid", gap: theme.space(3) }}>
      <Watchers page={page} settle={(tag, receipt) => { if (groupStore.getState().reopen?.tracking && tag === pageRef.current.plan?.plan) return; update(settleTag(pageRef.current, tag, settledOf(receipt), key)); }} />
      {reopen?.check === "checking" ? <Loading text="Checking this save's outcome…" /> : null}
      {reopen?.notice ? <Note tone={reopen.check === "unavailable" ? "error" : "info"}>{reopen.notice}</Note> : null}
      {reopen?.memoryOnly ? <Note tone="info">{SAVE_MEMORY_ONLY}</Note> : null}
      {/* A page that can no longer be checked offers none of the steps a refused request asks for. */}
      {reopen?.check !== "unavailable" ? page.requests.filter(request => request.state === "refused" && request.selected && request.says).map(request => <Note key={request.rollId} tone="error">{request.says}</Note>) : null}
      {page.requests.some(request => request.state === "sending" && request.selected) ? <Loading text="Asking again…" /> : null}
      {reopen?.check === "undone" && reopen.redoHeld ? <Button disabled={frozen || offScene} onClick={() => { const active = currentSession(); const next = resumeSaveEdits(active, authorityOf(roomStore.getState(), active.page)); pageRef.current = next.page; groupStore.setState(next); }}>Resume your edits</Button> : null}
      {page.fill ? <Note tone="info">{page.fill.from}</Note> : null}
      {page.fill?.note ? <Note>{page.fill.note}</Note> : null}
      {page.cast?.says && page.damage === null ? <Note>{page.cast.says}</Note> : null}
      {page.castNote ? <Note tone="info">{page.castNote}</Note> : null}
      {page.cast?.blocked ? <Note tone="error">{page.cast.blocked}</Note> : null}
      {failed ? <SrdLoadFailed what="The stat blocks" inline /> : null}
      {offScene ? <Note tone="error">{`This group save is on ${sceneName}. Go back to it to apply.`}</Note> : null}
      {page.apply === "refused" && page.applySays ? <Note tone="error">{page.applySays}</Note> : null}
      {error ? (
        <div role="alert">
          <Note tone="error">{error}</Note>
        </div>
      ) : null}
      <fieldset disabled={frozen} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "contents" }}>
      {page.phase === "setup" ? (
        <>
          {fillFrom.length > 0 ? <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>{fillFrom}</div> : null}
          {setupControls}
          {page.test.kind !== "none" ? dcRow : null}
          {switches}
          {outcome}
          {rowList}
          {page.test.kind !== "none" ? (
            <GroupRollButton source={JSON.stringify([rollContext, rows.map((r) => [r, stateOf(shown, r)]), serverRolls(rows), panel.adv, panel.dis, panel.secret])} name={rollWords(shown)} capability={{ d20: hasServerRoll, visibility: hasServerRoll ? "selectable" : "request", batch: true }} valid={() => pageRef.current.phase === "setup" && !offScene} variant="primary" busy={loading} disabled={blocked !== null || offScene || rows.length === 0 || tooMany || bound !== null} onRoll={(override) => startRoll(undefined, override)}>
              {bound ?? (loading ? "Loading the stat blocks…" : rollWords(shown))}
            </GroupRollButton>
          ) : null}
        </>
      ) : (
        <>
          {rowList}
          {page.test.kind !== "none" ? dcRow : null}
          {outcome}
        </>
      )}
      </fieldset>
      {reopen?.check === "undone" && page.test.kind !== "none" ? <Button busy={page.rolls.some(roll => roll.state === "sending") || page.requests.some(request => request.state === "sending")} disabled={frozen || offScene} onClick={() => doReroll(rows.map(row => row.holder))}>Roll saves again</Button> : null}
      {(reopen?.check === "undone" || reopen?.check === "unavailable") ? (
        confirmStartOver ? <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), alignItems: "center" }}><span>Start over? This replaces these save results.</span><Button onClick={startOver}>Start over</Button><Button onClick={() => setConfirmStartOver(false)}>Keep this save</Button></div> : <Button onClick={() => setConfirmStartOver(true)}>Start over</Button>
      ) : null}
      {page.phase !== "applying" && page.phase !== "applied" ? (
        confirmDiscard ? (
          <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap", alignItems: "center" }}>
            <span>{`Discard the ${title}?`}</span>
            <Button variant="danger" onClick={close}>
              Discard
            </Button>
            <Button onClick={() => setConfirmDiscard(false)}>Keep it</Button>
          </div>
        ) : (
          <Button onClick={() => (rolledAny ? setConfirmDiscard(true) : close())}>Discard</Button>
        )
      ) : null}
      {/* Apply alone in the foot, so the count, the first row and Apply share a 130% phone's sheet with no scroll (5.8, Appendix D). Its own room is even above and below Apply, as the Log's composer's is, under the pane's inset at its foot (review LP17-HP-1). */}
      {page.phase !== "setup" || page.test.kind === "none" ? (
        <div style={{ ...stickyPaneFoot(theme.space(2), theme.color.surface), paddingTop: theme.space(2), display: "grid", gap: theme.space(1) }}>{applyButton}</div>
      ) : null}
      {page.apply === "taken" && !reopen?.tracking ? <AppliedToast page={page} ui={ui} /> : null}
    </div>
  );
}

/** The toast once Apply is taken: "Fireball: 5 took damage, 3 are Frightened. Undo takes it all back." Once per plan. */
function AppliedToast(props: { page: Page; ui: ReturnType<typeof useRoomUi> }) {
  const told = useRef<string | null>(null);
  const { page, ui } = props;
  useEffect(() => {
    const plan = page.plan;
    if (!plan || told.current === plan.plan) return;
    told.current = plan.plan;
    const hurt = plan.targets.filter((t) => t.amount !== undefined).length;
    const conditioned = plan.targets.filter((t) => t.effects && t.effects.length > 0).length;
    const name = page.fill?.name ?? "Group save";
    const parts = [hurt > 0 ? `${hurt} took damage` : null, conditioned > 0 ? `${conditioned} gained ${page.outcome.conditions.map(effectName).join(" and ")}` : null].filter(Boolean);
    ui.notify(plan.targets.length > 0 ? `${name}: ${parts.join(", ") || "applied"}. Undo takes it all back.` : `${name}: settled, no one hurt. Undo brings its card back.`, "info");
  }, [page, ui]);
  return null;
}

/**
 * One watcher for each tag the page waits on (doc 1 1.2), the plan's keyed
 * by its state so Apply again watches afresh. Each settles the newest page
 * when its receipt lands, never the page it was mounted with, so receipts
 * landing together never undo each other.
 */
function Watchers(props: { page: Page; settle(tag: string, receipt: ReceiptState): void }) {
  return (
    <>
      {waitingTags(props.page).map((tag) => (
        <ReceiptWatch key={tag === props.page.plan?.plan ? `plan:${tag}:${props.page.apply}` : tag} tag={tag} onSettled={(receipt) => props.settle(tag, receipt)} />
      ))}
    </>
  );
}

function settledOf(receipt: ReceiptState): Settled {
  if (receipt.state === "committed") return { state: "committed", lines: receipt.lines, ...(receipt.refused ? { refused: receipt.refused.text || receipt.refused.message } : {}) };
  if (receipt.state === "refused") return { state: "refused", says: receipt.text || receipt.message, message: receipt.message };
  return { state: "unknown" };
}

function ReceiptWatch(props: { tag: string; onSettled(receipt: ReceiptState): void }) {
  const receipt = useReceipt(props.tag);
  const said = useRef(false);
  useEffect(() => {
    if (said.current || !receipt || receipt.state === "sending" || receipt.state === "checking") return;
    said.current = true;
    props.onSettled(receipt);
  }, [receipt]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** The test: a save, a check or a skill, or "No save: everyone takes it" (5.1). */
function TestPicker(props: { page: Page; onChange(page: Page): void }) {
  const { page } = props;
  const kind = page.test.kind;
  const ability: AbilityKey = page.test.kind === "none" ? "dex" : page.test.ability;
  const skill = page.test.kind === "check" ? page.test.skill : undefined;
  const set = (test: GroupTest) => props.onChange({ ...page, test });
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <Segmented<GroupTest["kind"]>
        label="What they roll"
        value={kind}
        options={[
          { value: "save", label: "Save" },
          { value: "check", label: "Check" },
          { value: "none", label: "No save" },
        ]}
        onChange={(k) => set(k === "none" ? { kind: "none" } : k === "save" ? { kind: "save", ability } : { kind: "check", ability })}
        grow
      />
      {kind === "none" ? <Note>No save: everyone takes it.</Note> : null}
      {kind !== "none" ? (
        <FieldRow label="Ability" fill>
          <Select<AbilityKey> label="Ability" value={ability} options={ABILITY_KEYS.map((a) => ({ value: a, label: ABILITY_NAMES[a] }))} onChange={(a) => set(kind === "save" ? { kind: "save", ability: a } : { kind: "check", ability: a })} />
        </FieldRow>
      ) : null}
      {kind === "check" ? (
        <FieldRow label="Skill" fill>
          <Select<SkillKey | "">
            label="Skill"
            value={skill ?? ""}
            options={[{ value: "", label: "None" }, ...SKILL_KEYS.map((k) => ({ value: k, label: SKILLS[k].name }))]}
            onChange={(k) => set(k === "" ? { kind: "check", ability } : { kind: "check", ability: SKILLS[k].ability, skill: k })}
          />
        </FieldRow>
      ) : null}
    </div>
  );
}

function OutcomePanel(props: {
  page: Page;
  open: boolean;
  summary: string;
  onOpen(): void;
  onChange(page: Page): void;
  onRoll(override?: RollModeOverride): void;
  blocked: boolean;
  /** A save whose outcome is checking or cannot be checked: its disabled fieldset already stops these controls, and they should look stopped as on an applied page. */
  locked: boolean;
  picking: boolean;
  setPicking(v: boolean): void;
  parsed: ReturnType<typeof parseParts> | null;
  view: RoomState;
  me: string;
  onSlot?: (slot: number) => void;
}) {
  const { page } = props;
  const theirs = useMemo(() => othersDamage(props.view, props.me, page.fill?.name), [props.view.log, props.me, page.fill?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  // Before the folded form's early return, so every render calls the same hooks.
  const damageId = useId();
  // Read from the page each render, so the form follows a fill, a DC typed later and a reload, never a copy taken once.
  const saveEnds = page.outcome.saveEnds;
  const save: SaveEndsForm = { on: saveEnds !== null, ability: saveEnds?.ability ?? (page.test.kind === "none" ? "wis" : page.test.ability), dc: saveEnds?.dc ?? null, spell: page.spell };
  const frozen = page.phase === "applying" || page.phase === "applied" || props.locked;
  const setOutcome = (patch: Partial<Page["outcome"]>) => props.onChange({ ...page, outcome: { ...page.outcome, ...patch } });
  const damageState = page.damage;
  const damageReceipt = useReceipt(damageState?.tag ?? null);
  const secretDamage = damageReceipt?.state === "committed" && damageReceipt.lines.some((line) => line.data?.type === "dice" && line.data.to === "dm");
  if (!props.open) {
    return (
      <div style={{ display: "flex", gap: theme.space(2), alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ flex: 1, minWidth: 0 }}>{props.summary}</span>
        <Button size="sm" onClick={props.onOpen}>
          Edit
        </Button>
      </div>
    );
  }
  const rolledText =
    damageState?.state === "committed" && damageState.amounts
      ? secretDamage && !page.secret ? "Rolled, Secret" : "Rolled"
      : damageState?.state === "sending" ? "Rolling…" : damageState?.state === "refused" ? damageState.says : damageState?.state === "unknown" ? "This may have happened. Check the log." : null;
  const damageParts = amountsOf(page, page.fill?.damageType);
  const summaryParts = damageParts ?? (props.parsed?.ok ? props.parsed.parts : []);
  const hasDice = props.parsed?.ok === true && props.parsed.parts.some((p) => "formula" in p);
  const fight = props.view.encounter?.entries ?? [];
  return (
    <div role="group" aria-label="Outcome" style={{ display: "grid", gap: theme.space(2) }}>
      {/* A visible name, so the field never reads as part of the fold above it (LP7-PC-10). */}
      <label htmlFor={damageId} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
        Damage
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (hasDice && !frozen && damageState?.state !== "sending") props.onRoll();
        }}
        style={{ display: "flex", gap: theme.space(1), marginTop: -theme.space(1) }}
      >
        <Input
          id={damageId}
          value={page.outcome.damage}
          disabled={frozen}
          placeholder="8d6 fire, or 28"
          enterKeyHint="done"
          autoComplete="off"
          onChange={(e) => setOutcome({ damage: e.target.value })}
          error={props.parsed !== null && !props.parsed.ok}
          style={{ flex: 1, width: 0 }}
        />
        {hasDice ? (
          <GroupRollButton type="button" source={JSON.stringify([page.id, page.sceneId, page.phase, page.outcome.damage, page.fill, page.secret, damageState, damageTo(page, props.view)])} name="Group damage" capability={{ d20: false, visibility: damageTo({ ...page, secret: true }, props.view) === "dm" ? "selectable" : "creature", damage: true }} valid={() => !frozen && hasDice && !props.blocked} size="sm" disabled={frozen} busy={damageState?.state === "sending"} onRoll={props.onRoll}>
            {damageState?.state === "committed" ? "Roll again" : "Roll"}
          </GroupRollButton>
        ) : null}
      </form>
      {props.parsed && !props.parsed.ok ? <Note tone="error">{props.parsed.error}</Note> : rolledText ? <Note><RollResultLine text={rolledText === "Rolled, Secret" ? "Rolled" : rolledText} expanded={rolledText} missing=" Secret" /></Note> : null}
      {summaryParts.length > 0 ? <DamageSummary summary={damageSummary(summaryParts)} /> : null}
      {theirs && !frozen ? (
        <ChipRow label="Rolled by someone else">
          <Chip onClick={() => setOutcome({ damage: theirs.text })}>{theirs.chip}</Chip>
        </ChipRow>
      ) : null}
      {props.onSlot && page.outcome.slot !== undefined ? (
        <FieldRow label="Slot level" fixed>
          <Stepper label="Slot level" value={page.outcome.slot} step={1} min={1} max={9} onChange={props.onSlot} />
        </FieldRow>
      ) : null}
      <FieldRow label="On a pass">
        <Segmented<"half" | "none">
          label="On a pass"
          value={page.outcome.onPass}
          options={[
            { value: "half", label: "Half" },
            { value: "none", label: "None" },
          ]}
          onChange={(onPass) => setOutcome({ onPass })}
          disabled={frozen}
        />
      </FieldRow>
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <ChipRow label="On a fail">
          {page.outcome.conditions.map((k) => (
            <Chip key={k} remove onClick={() => setOutcome({ conditions: page.outcome.conditions.filter((c) => c !== k) })} aria-label={`Remove ${effectName(k)}`}>
              {effectName(k)}
            </Chip>
          ))}
          {page.outcome.conditions.length < 3 && !frozen ? <Chip onClick={() => props.setPicking(!props.picking)}>Add a condition</Chip> : null}
        </ChipRow>
        {props.picking ? (
          <EffectPicker
            present={page.outcome.conditions.map((k) => ({ id: k, key: k }) as Effect)}
            onPick={(k) => {
              if ((CONDITION_KEYS as readonly string[]).includes(k) && !page.outcome.conditions.includes(k)) setOutcome({ conditions: [...page.outcome.conditions, k] });
              props.setPicking(false);
            }}
          />
        ) : null}
        {page.outcome.conditions.length > 0 ? (
          <>
            <FieldRow label="It lasts" fill>
              <Select<"none" | "turnStart" | "turnEnd" | "rounds">
                label="It lasts"
                value={page.outcome.lasts.mode}
                options={[
                  { value: "none", label: "Until removed" },
                  { value: "turnStart", label: "Until the start of the next turn" },
                  { value: "turnEnd", label: "Until the end of the next turn" },
                  { value: "rounds", label: "For a number of rounds" },
                ]}
                onChange={(mode) => setOutcome({ lasts: { ...page.outcome.lasts, mode } })}
              />
            </FieldRow>
            {page.outcome.lasts.mode !== "none" ? (
              <FieldRow label="Whose turn" fill>
                <Select<string>
                  label="Whose turn"
                  value={page.outcome.lasts.anchor}
                  options={[{ value: "own", label: "Each creature's own turn" }, ...fight.map((e) => ({ value: e.id, label: e.label ?? entryName(props.view, e) }))]}
                  onChange={(anchor) => setOutcome({ lasts: { ...page.outcome.lasts, anchor } })}
                />
              </FieldRow>
            ) : null}
            {page.outcome.lasts.mode === "rounds" ? (
              <FieldRow label="Rounds">
                <NumberField label="Rounds" value={page.outcome.lasts.rounds} min={1} max={1000} onCommit={(n) => n !== null && setOutcome({ lasts: { ...page.outcome.lasts, rounds: n } })} />
              </FieldRow>
            ) : null}
            <SaveEndsFields form={save} follows={{ dc: page.dc }} onChange={(f) => setOutcome({ saveEnds: f.on ? { ability: f.ability, dc: f.dc } : null })} />
          </>
        ) : null}
      </div>
    </div>
  );
}

function entryName(view: RoomState, entry: { tokenId?: string; characterId?: string }): string {
  if (entry.tokenId) return view.tokens[entry.tokenId]?.name ?? "A creature";
  if (entry.characterId) return view.characters[entry.characterId]?.name ?? "A character";
  return "A creature";
}

/**
 * One row (5.2, 5.4, 5.8): its name and amount on the first line, its
 * Fail, Pass and Skip, then its details: its total and dice, its way, its
 * outcome in words, and the switches only it needs.
 */
function GroupRow(props: {
  page: Page;
  source: string;
  row: RowBase;
  outcome: ReturnType<typeof rowOutcome>;
  /** Its stat block is still loading, so how it rolls is not known yet. */
  loading: boolean;
  /** How proficient it is in the page's save or skill, which its name carries: the page names the test once for every row (D-261029-415). */
  level?: Proficiency | undefined;
  blocked: string | null;
  onChange(page: Page): void;
  /** The DM's roll of an asked row, with the bonus typed for a creature with no stat block. */
  onDmRoll(typed?: number, override?: RollModeOverride): void;
  onRollAgain(override?: RollModeOverride): void;
  reopened?: boolean;
  onAskAgain(): void;
}) {
  const { page, row, outcome } = props;
  const s = stateOf(page, row);
  const setup = page.phase === "setup";
  const frozen = page.phase === "applying" || page.phase === "applied" || props.blocked !== null;
  const words = rowWords(page, row, outcome);
  const details: string[] = [];
  if (s.says) details.push(s.says);
  if (row.why && setup) details.push(`Not asked: ${row.why}`);
  // The slip explains typed parts and defenses. A plain override still needs its comparison in words.
  const slipSaysIt = outcome.summary !== undefined && (s.amount === undefined || outcome.damage !== undefined);
  details.push(...words.notes.filter((note) => !slipSaysIt || note !== outcome.words));
  if (s.amount !== undefined && outcome.damage && outcome.computed !== null) details.push(`Typed override, worked out ${outcome.computed}`);
  // The control shows the DM's own mark alone: a computed pass or fail is the verdict beside the total, which a DC change judges again.
  const markValue: Mark | null = s.mark ?? null;
  const waitingAsk = s.asked && !s.answer && !page.requests.some(request => request.rollId === s.asked?.rollId && (request.state === "closed" || request.state === "refused"));
  const set = (patch: Partial<typeof s>) => props.onChange({ ...page, states: { ...page.states, [row.holder]: { ...s, ...patch } } });
  const conditionsAnyway = outcome.skips.length > 0 || (s.conditions === "off" && page.outcome.conditions.length > 0);
  const switches = outcome.legendaryLeft > 0 || outcome.evasionApplies || outcome.qualified.length > 0 || conditionsAnyway;
  // The amount opens a field of its own (5.4): what the DM types there wins, and going back takes the worked-out amount again.
  const [editing, setEditing] = useState(false);
  // The DM's roll for an asked creature with no stat block takes the bonus typed beside it (knownOrTyped).
  const [bonusText, setBonusText] = useState("");
  const typed = knownOrTyped(row.bonus, bonusText, !props.loading);
  const receipt = useReceipt(s.batch?.tag ?? null);
  const returned = s.answer?.dice ?? s.rolled;
  const secret = receipt?.state === "committed" && receipt.lines.some((line) => line.data?.type === "dice" && line.data.to === "dm");
  const how = words.how;
  const text = how ?? (s.way === "server" ? serverWords(row, s) : WAY_WORDS[s.way]);
  const effective = returned ? informativeRollMode({ ...returned, mode: undefined, cancelled: undefined }, secret && !page.secret) : "";
  // A page with No save has no roll, so it is in setup until Apply: its rows' amounts open there too.
  const takes = (!setup || page.test.kind === "none") && !frozen && !s.gone && (outcome.result === "fail" || outcome.result === "pass");
  return (
    <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1) }}>
        <span style={{ fontWeight: theme.weight.strong, minWidth: 80, flex: "1 1 80px", overflowWrap: "anywhere" }}>{props.level ? <ProficiencyLabel level={props.level}>{row.name}</ProficiencyLabel> : row.name}</span>
        {takes ? (
          <Button size="sm" variant="quiet" expanded={editing} aria-label={`${row.name}'s damage, ${outcome.amount}${s.amount !== undefined ? ", typed" : ""}. Change it`} onClick={() => setEditing((e) => !e)} style={{ fontVariantNumeric: "tabular-nums", minWidth: 44 }}>
            {String(outcome.amount)}
          </Button>
        ) : (
          <span style={{ fontVariantNumeric: "tabular-nums", minWidth: 36, textAlign: "right" }}>{s.gone ? "Gone" : outcome.amount > 0 ? outcome.amount : ""}</span>
        )}
        <div style={{ flex: "1 1 170px", minWidth: 170 }}>
          <Segmented<Mark>
            label={`${row.name}: fail, pass or skip`}
            value={markValue}
            options={MARKS}
            onChange={(m) => props.onChange(mark(page, row.holder, s.mark === m ? null : m))}
            disabled={frozen}
            grow
          />
        </div>
      </div>
      {takes && editing ? (
        <RowDamageField name={row.name} value={s.amount} computed={outcome.computed} summary={outcome.summary} onChange={(value) => props.onChange(setAmount(page, row.holder, value))} />
      ) : null}
      {setup && props.loading ? (
        <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>Loading</span>
      ) : setup && row.ways.length > 1 ? (
        <>
          <Segmented<Way>
            label={`How ${row.name} rolls`}
            value={s.way}
            options={row.ways.map((w) => ({ value: w, label: w === "server" ? serverWords(row, s) : WAY_WORDS[w] }))}
            onChange={(way) => set({ way })}
          />
          {s.way === "server" && row.bonus === null ? <RowBonusField name={row.name} value={s.typedBonus} onChange={(typedBonus) => set({ typedBonus })} /> : null}
        </>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
          <RollResultLine text={text} suffix={effective ? `, ${effective}` : ""} style={{ fontSize: theme.font.small, color: theme.color.textMuted }} />
          {words.verdict ? (
            <span data-verdict="" style={{ fontSize: theme.font.small, color: theme.color.text, border: `${theme.line.border}px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.sm, padding: `0 ${theme.space(1)}px` }}>
              {words.verdict}
            </span>
          ) : null}
        </div>
      )}
      {outcome.summary && !(takes && editing) ? <DamageSummary summary={outcome.summary} /> : null}
      {details.length > 0 ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted, display: "grid", gap: theme.space(1) }}>{details.map((d, i) => <span key={i}>{d}</span>)}</div> : null}
      {!setup && !frozen ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), alignItems: "center" }}>
          {waitingAsk && (row.bonus !== null || typed.typing) ? (
            // The typed bonus and the roll it feeds wrap as one.
            <div style={{ display: "flex", alignItems: "center", gap: theme.space(1), flex: "none" }}>
              {typed.typing ? (
                <Input
                  aria-label={`Bonus for ${row.name}`}
                  value={bonusText}
                  placeholder="+0"
                  enterKeyHint="done"
                  autoComplete="off"
                  maxLength={3}
                  error={typed.error}
                  onChange={(e) => setBonusText(e.target.value)}
                  style={{ width: 64, flex: "none", textAlign: "center" }}
                />
              ) : null}
              <GroupRollButton
                source={JSON.stringify([props.source, bonusText])} name={`${row.name}'s requested roll`}
                capability={{ d20: true, visibility: "request" }} valid={() => !!waitingAsk && typed.bonus !== null && !frozen}
                onRoll={(override) => typed.bonus !== null && props.onDmRoll(typed.typing ? typed.bonus : undefined, override)}
                size="sm"
                disabled={(props.blocked ?? typed.waits) !== null}
                title={props.blocked ?? typed.waits ?? undefined}
                busy={page.dmRolls.some((r) => r.holder === row.holder && r.state === "sending")}
              >
                {row.bonus !== null ? `Roll ${signedText(row.bonus)}` : typed.bonus !== null ? `Roll ${d20Text(typed.bonus)}` : "Roll d20"}
              </GroupRollButton>
            </div>
          ) : null}
          {s.status === "notRolled" || s.status === "unknown" || props.reopened && s.way === "server" && !s.gone && s.mark !== "skip" ? (
            <GroupRollButton source={props.source} name={`${row.name}'s roll`} capability={{ d20: true, visibility: "selectable" }} valid={() => !frozen && !s.gone && (props.reopened || s.status === "notRolled" || s.status === "unknown") === true} size="sm" busy={page.rolls.some(roll => roll.state === "sending" && roll.holders.includes(row.holder))} disabled={props.blocked !== null || rowBonus(row, s) === null} onRoll={props.onRollAgain}>
              {props.reopened || s.status === "unknown" ? "Roll again" : "Roll them"}
            </GroupRollButton>
          ) : null}
          {props.reopened && s.way === "ask" && !s.gone && s.mark !== "skip" ? <Button size="sm" disabled={props.blocked !== null || page.requests.some(request => request.state === "sending")} onClick={props.onAskAgain}>Ask again</Button> : null}
          {s.way === "type" || s.status ? (
            <NumberField label={`${row.name}'s total`} value={s.typed} min={-50} max={100} nullable placeholder="Total" onCommit={(n) => props.onChange(typeTotal(page, row.holder, n))} width={88} />
          ) : null}
          {switches ? (
            // The row's switches grow to fill a line they wrap onto, so one that wraps reads as a line of its own, not as left behind by the buttons above it.
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1), flex: "1 1 auto" }}>
              {outcome.legendaryLeft > 0 ? (
                <Checkbox checked={s.legendary === true} onChange={(legendary) => set({ legendary })} label={`Use Legendary Resistance (${outcome.legendaryLeft} left)`} />
              ) : null}
              {outcome.evasionApplies ? <Checkbox checked={outcome.evasion} onChange={(evasion) => set({ evasion })} label="Evasion" /> : null}
              {outcome.qualified.map((q) => (
                <Checkbox
                  key={q.key}
                  checked={(s.qualifiedOn ?? []).includes(q.key)}
                  onChange={(on) => set({ qualifiedOn: on ? [...(s.qualifiedOn ?? []), q.key] : (s.qualifiedOn ?? []).filter((k) => k !== q.key) })}
                  label={q.words}
                />
              ))}
              {conditionsAnyway ? (
                <Checkbox checked={s.conditions === "on"} onChange={(on) => set({ conditions: on ? "on" : undefined })} label="Give the conditions anyway" />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { DAMAGE_TYPES, type DamageType };

/**
 * The Dice panel's notice of the open group save (5.1): "Fireball's save: 2
 * waiting." with Open. An info notice between the roll modes and the
 * creature card, so the DM reads an unfinished group save as a status
 * rather than one more line of the panel (docs/design-v1-dice-pass.md 7.8).
 */
export function OpenGroupSave(props: { page: Page; onOpen(): void }) {
  const { page } = props;
  const waiting = page.phase === "setup" ? 0 : [...results(page).values()].filter((r) => r === null).length;
  const state = openSaveState(page, waiting);
  return (
    // A notice draws no marks of its own, so a plain box carries the one the alignment sweep and the e2e suites find it by.
    <div data-open-group-save="" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)" }}>
      <Notice
        tone="info"
        action={
          <Button size="sm" onClick={props.onOpen}>
            Open
          </Button>
        }
      >
        {`${pageTitle(page)}: ${state}.`}
      </Notice>
    </div>
  );
}

/**
 * The newest damage line labelled with the fill's name that someone else
 * rolled (5.4): "Use Bree's 28 (Fireball damage)", whose tap takes its
 * totals, each with its type.
 */
function othersDamage(view: RoomState, me: string, name: string | undefined): { chip: string; text: string } | null {
  if (!name) return null;
  for (let i = view.log.length - 1; i >= 0; i--) {
    const data = view.log[i]!.data;
    if (data?.type !== "dice" || data.rolls.length === 0) continue;
    if (!data.rolls.every((r) => r.label?.startsWith(`${name} damage`))) continue;
    if (data.by === me) return null;
    const total = data.rolls.reduce((n, r) => n + r.total, 0);
    const who = view.members[data.by]?.name ?? "Someone";
    const text = data.rolls.map((r) => `${r.total}${r.label?.includes(", ") ? ` ${r.label.split(", ").at(-1)}` : ""}`).join(" + ");
    return { chip: `Use ${who}'s ${total} (${name} damage)`, text };
  }
  return null;
}

/** The folded "What players see" in the request sheet's words (rolls/logic.ts seenSummary), for a group save's two switches. */
function groupSeen(dcShown: boolean, hasDc: boolean, resultShown: boolean): string {
  if (hasDc && dcShown) return resultShown ? "The DC and pass or fail." : "The DC. Pass or fail hidden.";
  if (hasDc) return resultShown ? "DC hidden. Pass or fail shown." : "DC and pass or fail hidden.";
  return resultShown ? "Pass or fail shown." : "Pass or fail hidden.";
}

function GroupRollButton(props: Omit<ButtonProps, "onClick"> & { source: string; name: string; capability: RollModeCapability; valid(): boolean; onRoll(override?: RollModeOverride): void }) {
  const { source, name, capability, valid, onRoll, ...button } = props;
  const room = useRoomStore();
  const viewing = useRoomView((s) => s.sceneId);
  const liveView = useRoomView((s) => s.view);
  const binding = useRollModeMenu({ source: `${viewing}|${source}`, name, capability, dm: true, disabled: button.disabled || button.busy, valid: () => room.getState().connection === "open" && room.getState().sceneId === viewing && room.getState().view === liveView && valid(), onTap: () => onRoll(), onRoll });
  return <><Button {...button} {...binding.buttonProps} aria-describedby={binding.describe(button["aria-describedby"])} style={{ ...button.style, ...binding.pressStyle }} />{binding.menu}</>;
}

/** Player-caster damage keeps its public route, including from an older open menu. */
export function groupDamageInvocation(page: Page, view: RoomState, override?: RollModeOverride): { to: "all" | "dm"; rolls: PanelRoll[] } {
  const baseline = damageTo(page, view);
  const selectable = damageTo({ ...page, secret: true }, view) === "dm";
  const to = selectable ? rollModeTo(baseline, baseline, override) : baseline;
  const parsed = parseParts(page.outcome.damage, page.fill?.damageType);
  const named = page.fill ? (to === "dm" ? page.fill.name : publicName(page.fill)) : "Group save";
  return { to, rolls: parsed.ok ? parsed.parts.flatMap((p) => "formula" in p ? [{ formula: p.formula, modeEligible: false, label: `${named} damage${p.type ? `, ${damageTypeName(p.type)}` : ""}`.slice(0, 60), ...(p.type ? { type: p.type } : {}) }] : []) : [] };
}
