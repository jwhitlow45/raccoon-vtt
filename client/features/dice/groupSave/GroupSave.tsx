import { useEffect, useId, useMemo, useRef, useState } from "react";
import { bonusFor } from "#shared/dice/bonus.ts";
import type { AdvantageSource } from "#shared/dice/formula.ts";
import { uuidv7 } from "#shared/ids.ts";
import { ABILITY_KEYS, CONDITION_KEYS, SKILL_KEYS, type AbilityKey, type ConditionKey, type Effect, type RoomState, type SkillKey } from "#shared/model.ts";
import type { ActorTarget, OpOf } from "#shared/protocol.ts";
import { DAMAGE_TYPES, type DamageType } from "#shared/rules/damage.ts";
import { ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { effectName } from "#shared/logText.ts";
import { Button } from "../../../components/Button.tsx";
import { Checkbox } from "../../../components/Checkbox.tsx";
import { Chip, ChipRow } from "../../../components/Chip.tsx";
import { Input } from "../../../components/Field.tsx";
import { Segmented } from "../../../components/Segmented.tsx";
import { stickyPaneFoot } from "../../../components/Sheet.tsx";
import { Section } from "../../../components/Panel.tsx";
import { Switch } from "../../../components/Switch.tsx";
import { theme } from "../../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../../state/view.ts";
import { usePanelHeader } from "../../panels.ts";
import { EffectPicker } from "../../tokens/EffectsSection.tsx";
import { SaveEndsFields, type SaveEndsForm } from "../../tokens/SaveEndsFields.tsx";
import { FieldRow, Note, NumberField, Select, Stepper } from "../../tokens/ui.tsx";
import { creatureRolls } from "../creature.ts";
import { creatureKey, readUsed, signedText, spendOnStart, withUsed, writeUsed } from "../options.ts";
import { presetFor } from "../presets.ts";
import { useRollSender } from "../send.ts";
import { useDicePanel } from "../useDicePanel.ts";
import { useDiceView } from "../useDiceView.ts";
import { SrdLoadFailed } from "../../monsters/SrdLoadFailed.tsx";
import { useReceipt, type ReceiptState } from "../useReceipt.ts";
import { useRollBlocked } from "../useRollOption.ts";
import { knownOrTyped, parseBonus } from "../../rolls/card.ts";
import {
  apply,
  applyAgain,
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
  sourceIds,
  stateOf,
  syncRequests,
  typeTotal,
  readDraft,
  waitingTags,
  writeDraft,
  type Command,
  type Settled,
  type Page,
  type ServerRoll,
  type Step,
} from "./chain.ts";
import { parseParts } from "./outcome.ts";
import { amountsOf, applyWaits, applyWords, buildPlan, damageTo, openSaveState, pageBound, rowOutcome, rowWords } from "./plan.ts";
import { countWords, creatureCount, d20Of, groupRows, rowBonus, type GroupTest, type Mark, type RowBase, type RowState, type Way } from "./rows.ts";
import { useGroupSave, useGroupSaveStore } from "./store.ts";
import { actionFill, areaFill, casterActions } from "./fills.ts";

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
  const [text, setText] = useState(props.value === undefined ? "" : signedText(props.value));
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
  return s.typedBonus !== undefined ? `Server d20${signedText(s.typedBonus)}` : "Server d20";
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
  const roomId = useRoomView((s) => s.roomId);
  const viewing = useRoomView((s) => s.sceneId);
  const view = useRoomView((s) => s.view);
  const me = useRoomView((s) => s.you?.memberId ?? "");
  const actions = useRoomActions();
  const ui = useRoomUi();
  const panel = useDicePanel();
  const sender = useRollSender();
  const blocked = useRollBlocked();
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [seenOpen, setSeenOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [outcomeOpen, setOutcomeOpen] = useState(page.phase === "setup");
  const pageRef = useRef(page);
  pageRef.current = page;
  const update = (next: Page) => {
    const prev = pageRef.current;
    // A roll belongs to the parts it rolled: new parts drop it, so its amounts never land on parts it did not roll.
    const checked = next.outcome.damage !== prev.outcome.damage && next.damage !== null && next.damage === prev.damage ? { ...next, damage: null } : next;
    pageRef.current = checked;
    set(checked);
  };

  // The draft follows the page (5.10), inside try and catch.
  useEffect(() => writeDraft(roomId, page), [roomId, page]);

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
  const live = dice && page.phase === "setup" ? groupRows(dice, fromSource, page.test, page.spell) : page.rows;
  const rows = live;
  const tooMany = rows.length > 100;
  const shown: Page = page.phase === "setup" ? { ...page, rows } : page;
  const key = (t: { tokenId?: string; characterId?: string }) => (view ? creatureKey(view, t) : "");

  // Answers come from the requests in the view (5.3), and creatures that left are marked gone, after the roll.
  useEffect(() => {
    if (!view || page.phase === "setup") return;
    let next = syncRequests(pageRef.current, view.rolls, key);
    next = markGone(next, viewing, (row) => view.tokens[row.tokenId] !== undefined);
    if (next !== pageRef.current) update(next);
  }, [view?.rolls, view?.tokens, viewing, page.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = pageTitle(shown);
  usePanelHeader({ title, parent: props.parent, onBack: props.onBack });
  const rollNowRef = useRef<() => void>(() => undefined);
  // A quick tap waits for the stat blocks, so a monster whose bonus is still loading is never left to be typed.
  const ready = view !== null && dice !== null && rows.length > 0 && !loading;
  useEffect(() => {
    if (ready && page.phase === "setup" && page.rollNow) rollNowRef.current();
  }, [ready, page.phase, page.rollNow]);
  if (!view || !dice) return <Note>Loading the creatures…</Note>;

  const offScene = page.sceneId !== viewing;
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
        actions.dispatch(c.op, {
          quiet: true,
          onAnswer: (answer, refusal) => {
            if (answer === "taken") update(askAnswered(pageRef.current, rollId, { ok: true }));
            else if (answer === "refused") update(askAnswered(pageRef.current, rollId, { ok: false, message: refusal?.text ?? refusal?.message ?? "the request was refused" }));
          },
        });
      } else if (c.op.t === "roll.dice") {
        // The DM's tap on an asked row is settled by its receipt, as the page's other rolls are, so a reload in between settles it too.
        const tag = c.op.tag;
        sender.receipts.sending(tag, 0);
        const n = actions.dispatch(c.op, { quiet: true, onAnswer: (answer, refusal, cause) => sender.receipts.answer(tag, 0, answer, refusal, cause) });
        if (n === null) {
          sender.receipts.forget(tag, 0);
          update(dmRollSettled(pageRef.current, tag, "refused", "Not sent."));
        }
      } else actions.dispatch(c.op);
    }
  };

  // The outcome is tagged by its plan (doc 1 1.2): its receipt settles it, and only the DM's Apply again sends it again.
  const sendOutcome = (op: OpOf<"actor.outcome">) => {
    sender.receipts.sending(op.plan, 0);
    const n = actions.dispatch(op, { quiet: true, onAnswer: (answer, refusal, cause) => sender.receipts.answer(op.plan, 0, answer, refusal, cause) });
    if (n === null) sender.receipts.forget(op.plan, 0);
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

  const startRoll = (given?: AdvantageSource[]) => {
    if (bound) {
      setError(bound);
      return;
    }
    // A quick tap took the panel's choices when it was made, so they are its own. Otherwise this tap takes them.
    const taken = given ? { sources: given, restore: () => undefined } : panel.take();
    const step = roll(pageRef.current, { rows, server: serverRolls(rows), tag: uuidv7(), requestIds: () => actions.newId(), openRequests: Object.keys(view.rolls).length, taken: taken.sources, at: new Date().toISOString() });
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

  const rollDamage = () => {
    if (!parsedParts?.ok) return;
    const rollsToSend = parsedParts.parts.flatMap((p) => ("formula" in p ? [{ formula: p.formula, label: `${page.fill?.name ?? "Group save"} damage${p.type ? `, ${p.type}` : ""}`.slice(0, 60) }] : []));
    if (rollsToSend.length === 0) return;
    const tag = uuidv7();
    if (panel.roll(rollsToSend, { to: damageTo(page, view), tag }) !== null) update(damageSent(pageRef.current, tag));
  };

  const doApply = () => {
    const waits = applyWaits(shown, dice, amounts);
    if (waits) {
      setError(waits);
      return;
    }
    const plan = buildPlan(shown, dice, amounts, { plan: uuidv7(), newId: actions.newId });
    if (!plan) {
      setError("Nothing would change.");
      return;
    }
    const base = page.phase === "setup" ? { ...page, rows, phase: "rolled" as const } : page;
    // An action filled from a recharge is spent (6.4), once its outcome goes.
    const recharge = page.fill?.recharge;
    spendOnStart(() => run(apply(base, plan)), recharge ? () => writeUsed(roomId, withUsed(readUsed(roomId), recharge.holder, recharge.key, true)) : null);
  };

  const close = () => {
    send(discard(page));
    writeDraft(roomId, null);
    set(null);
    props.onBack();
  };

  const rolledAny = page.rolls.length > 0 || page.requests.length > 0 || page.damage !== null;
  const doneWords = page.apply === "taken" ? `Applied to ${page.plan?.targets.length ?? 0}. Undo takes it all back.` : null;

  // ---- the parts

  const setupControls = page.phase === "setup" ? <TestPicker page={page} onChange={update} /> : null;
  const dcRow = (
    <FieldRow label="DC">
      <NumberField label="DC" value={page.dc ?? undefined} min={1} max={50} nullable placeholder="None" onCommit={(dc) => update(setDc(pageRef.current, dc))} width={88} />
    </FieldRow>
  );
  const anyAsk = rows.some((r) => stateOf(shown, r).way === "ask");
  // Open server rolls carry the DC only when players may see it (chain.ts diceEnvelope), so the switch shows for them too.
  const openRolls = !page.secret && rows.some((r) => stateOf(shown, r).way === "server");
  const switches =
    page.phase === "setup" ? (
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <Switch label="Hide the monsters' rolls from players" help="Their damage too, unless a player's creature cast it." checked={page.secret} onChange={(secret) => update({ ...pageRef.current, secret })} />
        {page.test.kind === "save" ? <Switch label="Against a spell" help="A creature with Magic Resistance rolls with advantage, asked or not." checked={page.spell} onChange={(spell) => update({ ...pageRef.current, spell })} /> : null}
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
      onChange={update}
      onRoll={rollDamage}
      picking={picking}
      setPicking={setPicking}
      parsed={parsedParts}
      view={view}
      me={me}
      onSlot={
        page.source.kind === "area" && page.outcome.slot !== undefined
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

  const rowList = (
    <div role="group" aria-label="Creatures" style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        <span style={{ fontWeight: theme.weight.strong, flex: 1 }}>{page.phase === "setup" && page.test.kind !== "none" ? creatureCount(rows.length) : count}</span>
        <Button size="sm" disabled={page.phase === "applying" || page.phase === "applied"} onClick={() => update(rows.reduce((p, r) => (stateOf(p, r).mark === "skip" && r.skip ? p : mark(p, r.holder, "fail")), { ...pageRef.current, rows } as Page))}>
          All fail
        </Button>
        <Button size="sm" disabled={page.phase === "applying" || page.phase === "applied"} onClick={() => update(rows.reduce((p, r) => (stateOf(p, r).mark === "skip" && r.skip ? p : mark(p, r.holder, "pass")), { ...pageRef.current, rows } as Page))}>
          All pass
        </Button>
      </div>
      {tooMany ? <Note tone="error">At most 100 creatures in one group save.</Note> : null}
      {rows.length === 0 ? <Note>Select the creatures it hits, or place an area from it.</Note> : null}
      {rows.map((row) => (
        <GroupRow
          key={row.holder}
          page={shown}
          row={row}
          outcome={outcomes.get(row.holder)!}
          loading={loading && row.bonus === null}
          blocked={blocked ?? (offScene ? "Go back to the scene first." : null)}
          onChange={(next) => update(page.phase === "setup" ? { ...next, rows: pageRef.current.rows } : next)}
          onDmRoll={(typed) => {
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
              ...modeOf(preset.sources),
            };
            run(dmRoll(pageRef.current, row.holder, op));
          }}
          onRollAgain={() => run(rollAgain(pageRef.current, { holders: [row.holder], server: serverRolls([row]), tag: uuidv7() }))}
        />
      ))}
    </div>
  );

  const waits = page.phase === "applied" ? null : applyWaits(shown, dice, amounts);
  const applyButton =
    page.phase === "applied" ? (
      <div style={{ display: "grid", gap: theme.space(1) }}>
        <Note tone="info">{doneWords}</Note>
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
      </div>
    ) : (
      <Button variant="primary" busy={page.apply === "sending"} disabled={blocked !== null || offScene || waits !== null || bound !== null || tooMany} onClick={doApply}>
        {waits ?? bound ?? applyWords(outcomeList, conditions)}
      </Button>
    );

  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      <Watchers page={page} settle={(tag, receipt) => update(settleTag(pageRef.current, tag, settledOf(receipt), key))} />
      {page.fill ? <Note tone="info">{page.fill.from}</Note> : null}
      {failed ? <SrdLoadFailed what="The stat blocks" inline /> : null}
      {offScene ? <Note tone="error">{`This group save is on ${sceneName}. Go back to it to apply.`}</Note> : null}
      {page.apply === "refused" && page.applySays ? <Note tone="error">{page.applySays}</Note> : null}
      {error ? (
        <div role="alert">
          <Note tone="error">{error}</Note>
        </div>
      ) : null}
      {page.phase === "setup" ? (
        <>
          {fillFrom.length > 0 ? <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>{fillFrom}</div> : null}
          {setupControls}
          {page.test.kind !== "none" ? dcRow : null}
          {switches}
          {outcome}
          {rowList}
          {page.test.kind !== "none" ? (
            <Button variant="primary" busy={loading} disabled={blocked !== null || offScene || rows.length === 0 || tooMany || bound !== null} onClick={() => startRoll()}>
              {bound ?? (loading ? "Loading the stat blocks…" : rollWords(shown))}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          {rowList}
          {page.test.kind !== "none" ? dcRow : null}
          {outcome}
        </>
      )}
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
      {/* Apply alone in the foot, so the count, the first row and Apply share a 130% phone's sheet with no scroll (5.8, Appendix D). */}
      {page.phase !== "setup" || page.test.kind === "none" ? (
        <div style={{ ...stickyPaneFoot(theme.space(2)), background: theme.color.surface, paddingTop: theme.space(1), display: "grid", gap: theme.space(1) }}>{applyButton}</div>
      ) : null}
      {page.apply === "taken" ? <AppliedToast page={page} ui={ui} /> : null}
    </div>
  );
}

function modeOf(sources: readonly { kind: "adv" | "dis" }[]): { mode?: "adv" | "dis"; cancelled?: true } {
  const adv = sources.some((s) => s.kind === "adv");
  const dis = sources.some((s) => s.kind === "dis");
  if (adv && dis) return { cancelled: true };
  if (adv) return { mode: "adv" };
  if (dis) return { mode: "dis" };
  return {};
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
    ui.notify(`${name}: ${parts.join(", ") || "applied"}. Undo takes it all back.`, "info");
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
        <FieldRow label="Ability">
          <Select<AbilityKey> label="Ability" value={ability} options={ABILITY_KEYS.map((a) => ({ value: a, label: ABILITY_NAMES[a] }))} onChange={(a) => set(kind === "save" ? { kind: "save", ability: a } : { kind: "check", ability: a })} />
        </FieldRow>
      ) : null}
      {kind === "check" ? (
        <FieldRow label="Skill">
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
  onRoll(): void;
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
  const frozen = page.phase === "applying" || page.phase === "applied";
  const setOutcome = (patch: Partial<Page["outcome"]>) => props.onChange({ ...page, outcome: { ...page.outcome, ...patch } });
  const damageState = page.damage;
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
      ? `Rolled: ${damageState.amounts.flatMap((a, i) => (a === undefined ? [] : [`${a}${props.parsed?.ok && props.parsed.parts[i]?.type ? ` ${props.parsed.parts[i]!.type}` : ""}`])).join(" + ")}`
      : damageState?.state === "sending" ? "Rolling…" : damageState?.state === "refused" ? damageState.says : damageState?.state === "unknown" ? "This may have happened. Check the log." : null;
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
          if (hasDice) props.onRoll();
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
          <Button type="submit" size="sm" disabled={frozen} busy={damageState?.state === "sending"}>
            {damageState?.state === "committed" ? "Roll again" : "Roll"}
          </Button>
        ) : null}
      </form>
      {props.parsed && !props.parsed.ok ? <Note tone="error">{props.parsed.error}</Note> : rolledText ? <Note>{rolledText}</Note> : null}
      {theirs && !frozen ? (
        <ChipRow label="Rolled by someone else">
          <Chip onClick={() => setOutcome({ damage: theirs.text })}>{theirs.chip}</Chip>
        </ChipRow>
      ) : null}
      {props.onSlot && page.outcome.slot !== undefined ? (
        <FieldRow label="Slot level">
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
            <FieldRow label="It lasts">
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
              <FieldRow label="Whose turn">
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
  row: RowBase;
  outcome: ReturnType<typeof rowOutcome>;
  /** Its stat block is still loading, so how it rolls is not known yet. */
  loading: boolean;
  blocked: string | null;
  onChange(page: Page): void;
  /** The DM's roll of an asked row, with the bonus typed for a creature with no stat block. */
  onDmRoll(typed?: number): void;
  onRollAgain(): void;
}) {
  const { page, row, outcome } = props;
  const s = stateOf(page, row);
  const setup = page.phase === "setup";
  const frozen = page.phase === "applying" || page.phase === "applied";
  const words = rowWords(page, row, outcome);
  const details: string[] = [];
  if (s.says) details.push(s.says);
  if (row.why && setup) details.push(`Not asked: ${row.why}`);
  details.push(...words.notes);
  // The control shows the DM's own mark alone: a computed pass or fail is the verdict beside the total, which a DC change judges again.
  const markValue: Mark | null = s.mark ?? null;
  const waitingAsk = s.asked && !s.answer;
  const set = (patch: Partial<typeof s>) => props.onChange({ ...page, states: { ...page.states, [row.holder]: { ...s, ...patch } } });
  // The amount opens a field of its own (5.4): what the DM types there wins, and going back takes the worked-out amount again.
  const [editing, setEditing] = useState(false);
  // The DM's roll for an asked creature with no stat block takes the bonus typed beside it (knownOrTyped).
  const [bonusText, setBonusText] = useState("");
  const typed = knownOrTyped(row.bonus, bonusText, !props.loading);
  // A page with No save has no roll, so it is in setup until Apply: its rows' amounts open there too.
  const takes = (!setup || page.test.kind === "none") && !frozen && !s.gone && (outcome.result === "fail" || outcome.result === "pass");
  return (
    <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0`, borderTop: `${theme.line.border}px solid ${theme.color.border}` }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1) }}>
        <span style={{ fontWeight: theme.weight.strong, minWidth: 80, flex: "1 1 80px", overflowWrap: "anywhere" }}>{row.name}</span>
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), alignItems: "center" }}>
          <NumberField label={`${row.name}'s damage`} value={s.amount} min={0} max={100_000} nullable placeholder={String(outcome.computed)} onCommit={(n) => props.onChange(setAmount(page, row.holder, n))} width={88} />
          {s.amount !== undefined ? (
            <Button size="sm" onClick={() => props.onChange(setAmount(page, row.holder, null))}>
              {`Back to ${outcome.computed}`}
            </Button>
          ) : null}
        </div>
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
          <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{words.how ?? (s.way === "server" ? serverWords(row, s) : WAY_WORDS[s.way])}</span>
          {words.verdict ? (
            <span data-verdict="" style={{ fontSize: theme.font.small, color: theme.color.text, border: `${theme.line.border}px solid ${theme.color.controlBorder}`, borderRadius: theme.radius.sm, padding: `0 ${theme.space(1)}px` }}>
              {words.verdict}
            </span>
          ) : null}
        </div>
      )}
      {details.length > 0 ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted, display: "grid", gap: 2 }}>{details.map((d, i) => <span key={i}>{d}</span>)}</div> : null}
      {!setup && !frozen ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), alignItems: "center" }}>
          {waitingAsk && typed.typing ? (
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
          {waitingAsk && (row.bonus !== null || typed.typing) ? (
            <Button
              size="sm"
              disabled={(props.blocked ?? typed.waits) !== null}
              title={props.blocked ?? typed.waits ?? undefined}
              busy={page.dmRolls.some((r) => r.holder === row.holder && r.state === "sending")}
              onClick={() => typed.bonus !== null && props.onDmRoll(typed.typing ? typed.bonus : undefined)}
            >
              {row.bonus !== null ? `Roll ${signedText(row.bonus)}` : typed.bonus !== null ? `Roll d20${signedText(typed.bonus)}` : "Roll d20"}
            </Button>
          ) : null}
          {s.status === "notRolled" || s.status === "unknown" ? (
            <Button size="sm" disabled={props.blocked !== null || rowBonus(row, s) === null} onClick={props.onRollAgain}>
              {s.status === "unknown" ? "Roll again" : "Roll them"}
            </Button>
          ) : null}
          {s.way === "type" || s.status ? (
            <NumberField label={`${row.name}'s total`} value={s.typed} min={-50} max={100} nullable placeholder="Total" onCommit={(n) => props.onChange(typeTotal(page, row.holder, n))} width={88} />
          ) : null}
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
          {outcome.skips.length > 0 || (s.conditions === "off" && page.outcome.conditions.length > 0) ? (
            <Checkbox checked={s.conditions === "on"} onChange={(on) => set({ conditions: on ? "on" : undefined })} label="Give the conditions anyway" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export { DAMAGE_TYPES, type DamageType };

/** The Dice panel's row for the open group save (5.1): "Fireball's save: 2 waiting. Open". */
export function OpenGroupSave(props: { page: Page; onOpen(): void }) {
  const { page } = props;
  const waiting = page.phase === "setup" ? 0 : [...results(page).values()].filter((r) => r === null).length;
  const state = openSaveState(page, waiting);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
      <span style={{ flex: 1, minWidth: 0 }}>{`${pageTitle(page)}: ${state}.`}</span>
      <Button size="sm" onClick={props.onOpen}>
        Open
      </Button>
    </div>
  );
}

/** A reload brings the tab's group save back from its draft (5.10), once, for the DM. */
export function useRestoreGroupSave(): void {
  const store = useGroupSaveStore();
  const roomId = useRoomView((s) => s.roomId);
  const dm = useRoomView((s) => s.you?.role === "dm");
  useEffect(() => {
    if (!dm || store.getState().page || store.getState().restored) return;
    const draft = readDraft(roomId);
    store.setState({ restored: true, ...(draft ? { page: draft } : {}) });
  }, [dm, roomId, store]);
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
