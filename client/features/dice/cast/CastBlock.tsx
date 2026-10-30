import { useEffect, useMemo, useRef, type RefObject } from "react";
import { useStore } from "zustand";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import { uuidv7 } from "#shared/ids.ts";
import type { CastAsk, RoomState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { useRollModeMenu } from "../useRollModeMenu.tsx";
import type { RollModeOverride } from "../rollMode.ts";
import { Button } from "../../../components/Button.tsx";
import { displayName } from "../../../lib/scene.ts";
import { scrollBox, startInScrollBox } from "../../../lib/reveal.ts";
import { theme } from "../../../lib/theme.ts";
import { useScoped } from "../../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../../state/view.ts";
import { caughtTokens, contextFrom, inAreaEntries, inAreaText } from "../../areas/coverage.ts";
import { useLiveGround } from "../../areas/liveGround.ts";
import { presetDraft } from "../../areas/presets.ts";
import { resolvedChoice, samplesNow, setDraft, startDraft, useAreaScope } from "../../areas/store.ts";
import { useLiveTokens } from "../../areas/useLiveTokens.ts";
import { useViewerFog } from "../../../canvas/viewerFog.ts";
import { Note } from "../../tokens/ui.tsx";
import type { DiceView } from "../creature.ts";
import { actionFill, areaFill } from "../groupSave/fills.ts";
import { foldKind, useDiceFolds } from "../diceFolds.ts";
import { creatureKey, damageRolls, markSendSeen } from "../options.ts";
import { useOption, useOptionStore, type CastBlock } from "../optionState.ts";
import { throwHooksSlot } from "../throw/hooks.ts";
import { useDicePanel } from "../useDicePanel.ts";
import { useReceipt } from "../useReceipt.ts";
import {
  areaPresetOf,
  askAgain,
  askFor,
  askInput,
  blockDone,
  blockLevel,
  casterToken,
  castSendsSlot,
  fillLine,
  fillRolls,
  followSend,
  forgetSend,
  openedBlock,
  pendingSend,
  phaseOf,
  retryFromList,
  rolledText,
  sameSpell,
  SELECT_TARGETS,
  selectionTargets,
  sendBlocked,
  sendSays,
  sendWords,
  spellLevel,
  targetsLine,
  waitingCount,
  waitingLines,
  withdrawAsk,
  writeCastDraft,
  type CastEnv,
  type CastSend,
} from "./cast.ts";
import { useCastTracker } from "./alerts.ts";

/**
 * A player's ask for saves in the Dice panel (docs/design-v1-player-save-spell.md
 * 3.1 and 3.2): the block under a spell's row, the waiting lines, and the
 * closing toasts. The rules are cast.ts's.
 */

/** What the sends need from this page: the socket, the Dice panel's roll with its throw, the toasts and the session draft. */
export function useCastEnv(): CastEnv {
  const store = useScoped(castSendsSlot);
  const tracker = useCastTracker();
  const room = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const panel = useDicePanel();
  const throws = useScoped(throwHooksSlot);
  const roomId = useRoomView((s) => s.roomId);
  return useMemo(
    () => ({
      store,
      tracker,
      connected: () => room.getState().connection === "open",
      dispatch: (op, opts) => actions.dispatch(op, opts),
      rollDamage: (rolls, override) => {
        let parts = 0;
        // Thrown from the tapped button's place, as the row's Damage throws (docs/design-v1-roll-animation.md 3.1).
        const tag = panel.roll(rolls, { origin: throws.current?.origin(), parts: (n) => (parts = n), ...(override ? { override } : {}) });
        return tag === null ? null : { tag, parts };
      },
      newId: uuidv7,
      view: () => room.getState().view,
      save: (sends) => writeCastDraft(roomId, sends),
      notify: (text) => ui.notify(text, "info"),
    }),
    [store, tracker, room, actions, ui, panel, throws, roomId],
  );
}

function useSends(): Record<string, CastSend> {
  return useStore(useScoped(castSendsSlot), (s) => s.sends);
}

/** The roll options' button outline (RollOptions.tsx OptionCell). */
const OPTION_OUTLINE = `${theme.line.border}px solid ${theme.color.controlBorder}`;

/**
 * Closes the open block once it is done (cast.ts blockDone): its ask
 * waits in the view, when the block becomes the row's waiting line, or
 * settled and went, or its send went from this page's sends (3.2). Run
 * above the options, never in the block, so a block its folded group or
 * another creature's tab keeps from drawing still closes, and the folded
 * line stops naming it (docs/design-v1-dice-pass.md 6.6).
 */
export function useCloseSettledBlock(view: Pick<RoomState, "casts"> | null): void {
  const store = useOptionStore();
  const tracker = useCastTracker();
  const sends = useSends();
  const cast = useOption((s) => s.cast);
  const sent = cast?.sent;
  const done = view !== null && blockDone(cast, sends, sent !== undefined ? phaseOf(tracker.state(sent), view.casts[sent] !== undefined) : null);
  useEffect(() => {
    if (cast && done) store.setState((s) => (s.cast === cast ? { cast: null } : {}));
  }, [cast, done, store]);
}

/** The row's own Ask for saves (3.1), where the DM's Group save stands. */
export function AskForSavesButton(props: { spec: CastBlock; ref?: RefObject<HTMLButtonElement | null> }) {
  const store = useOptionStore();
  const sendStore = useScoped(castSendsSlot);
  const tracker = useCastTracker();
  const room = useRoomStore();
  const open = () => {
    // A send of this row's that has not settled well comes back with its block, so it offers Ask again, never a second roll.
    const pending = pendingSend({ spec: props.spec, sends: sendStore.getState().sends, casts: room.getState().view?.casts ?? {}, state: (id) => tracker.state(id) });
    store.setState((s) => openedBlock(s, props.spec, pending?.id));
  };
  return (
    // It acts beside Attack and Damage, so it wears their outline, not the raised look's dim one (docs/design-v1-dice-pass.md 7.3).
    <Button ref={props.ref} size="sm" aria-label={`Ask the DM for saves against ${props.spec.spell}`} onClick={open} style={{ border: OPTION_OUTLINE }}>
      Ask for saves
    </Button>
  );
}

/** A row's or a creature's ask: its open block and the asks waiting in the view (3.1, 3.2). Its other sends lead the options (WaitingAsks), with or without a row. */
export function RowCast(props: {
  dice: DiceView;
  creatureKey: string;
  creature: ActorTarget;
  name: string;
  blocked: string | null;
  /** The row at its casting level, or null for the block of an area whose spell has no row. */
  named: NamedRoll | null;
  /** The row's own stepper's level, or null where it has none. */
  rowSlot: number | null;
  riders?: ReadonlySet<number>;
  onSent?(): void;
  /** The row's Ask for saves, which takes the focus back when the block closes. */
  opener?: RefObject<HTMLButtonElement | null>;
  /** The open block goes here: under its row, or at the top of the options for an area whose spell has none. */
  blockHere: boolean;
}) {
  const spec = useOption((s) => s.cast);
  const view = props.dice.view;
  const named = props.named;
  const mine = (s: { roll?: string; spell: string }) => named !== null && (s.roll === named.key || sameSpell(s.spell, named.name));
  const open = spec !== null && props.blockHere;
  const asks = named === null ? [] : Object.values(view.casts).filter((ask) => creatureKey(view, { tokenId: ask.caster }) === props.creatureKey && mine(ask));
  const wasOpen = useRef(open);
  useEffect(() => {
    // Back to the row's Ask for saves when its block closes (6, Accessibility).
    if (wasOpen.current && !open) props.opener?.current?.focus();
    wasOpen.current = open;
  });
  return (
    <>
      {asks.map((ask) => (
        <WaitingLine key={ask.id} ask={ask} />
      ))}
      {open && spec ? <CastBlockView {...props} spec={spec} /> : null}
    </>
  );
}

const LINE = { fontSize: theme.font.body14, lineHeight: theme.leading.body } as const;
const BUTTONS = { display: "flex", flexWrap: "wrap", gap: theme.space(1) } as const;

/** One waiting ask (3.2): "Asked the DM for saves. Waiting." with Withdraw, busy until it goes. */
function WaitingLine(props: { ask: Pick<CastAsk, "id" | "spell">; caster?: string }) {
  const env = useCastEnv();
  const withdrawing = useStore(env.store, (s) => s.withdrawing[props.ask.id] === true);
  const connected = useRoomView((s) => s.connection === "open");
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
      <span style={{ ...LINE, flex: "1 1 160px" }}>
        {props.caster ? `${props.caster}'s ${props.ask.spell}: asked` : "Asked"} the DM for saves. Waiting.
      </span>
      <Button size="sm" busy={withdrawing} disabled={!connected} aria-label={`Withdraw the ask for saves against ${props.ask.spell}`} onClick={() => withdrawAsk(env, props.ask.id)}>
        Withdraw
      </Button>
    </div>
  );
}

/**
 * A send this page made that is not in the view: still waiting for its
 * answer, refused, or unknown (3.1, 3.2). `lead` names it where no row or
 * block around it does: "Thorn's Fireball: not asked."
 */
function SendStatus(props: { send: CastSend; again?: () => string | null; onClosed?(): void; lead?: string }) {
  const env = useCastEnv();
  const state = env.tracker.state(props.send.id);
  const phase = phaseOf(state, false);
  const roll = useReceipt(props.send.damage?.tag ?? null);
  const rolled = roll?.state === "committed" ? rolledText(roll.lines) : null;
  const connected = useRoomView((s) => s.connection === "open");
  if (phase === "sending") return <div style={LINE}>{state?.state === "checking" ? "Checking…" : "Asking the DM for saves…"}</div>;
  if (phase !== "refused" && phase !== "unknown") return null;
  const close = () => {
    forgetSend(env, props.send.id);
    props.onClosed?.();
  };
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      {props.lead ? <div style={{ ...LINE, fontWeight: theme.weight.strong }}>{props.lead}</div> : null}
      {rolled ? <div style={LINE}>{rolled}</div> : null}
      <Note tone={phase === "refused" ? "error" : "info"}>{sendSays(state)}</Note>
      <div style={BUTTONS}>
        <Button size="sm" disabled={!connected} aria-label={`Ask again for saves against ${props.send.spell}`} onClick={() => (props.again ? props.again() : askAgain(env, props.send.id))}>
          Ask again
        </Button>
        <Button size="sm" variant="quiet" onClick={close}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** The live tokens' coverage of an area, as its In area line reads it: on a player's device by the walls they could know (areas/coverage.ts heldWalls). */
function useAreaEntries(view: RoomState, areaId: string | undefined, sceneId: string | null) {
  const live = useLiveTokens();
  const role = useRoomView((s) => s.you?.role ?? "player");
  const scene = sceneId ? view.scenes[sceneId] : undefined;
  const fog = useViewerFog({ scene, role, fog: scene?.fogEnabled !== false });
  // A player's line names only creatures whose rays lie on their live ground (areas/coverage.ts raysLive).
  const ground = useLiveGround(scene, role);
  const template = areaId ? view.templates[areaId] : undefined;
  if (!template || !scene || template.sceneId !== scene.id) return null;
  const ctx = contextFrom({ tokens: live.tokens, buildChunks: view.buildChunks, settings: view.meta.settings, live: ground }, scene, samplesNow(live.moving), fog);
  return inAreaEntries(caughtTokens(template, ctx, scene.id), live.tokens, view.characters);
}

/**
 * The block (3.1): who it targets, its casting level, and its send. The
 * caster is the creature's token on this scene, read again at the tap, and
 * every number is the player's own fill, so the DC reads as their block
 * gives it.
 */
function CastBlockView(props: Parameters<typeof RowCast>[0] & { spec: CastBlock }) {
  const { spec, dice } = props;
  const view = dice.view;
  const env = useCastEnv();
  const panel = useDicePanel();
  const store = useOptionStore();
  const room = useRoomStore();
  const ui = useRoomUi();
  const actions = useRoomActions();
  const area = useAreaScope();
  const sceneId = useRoomView((s) => s.sceneId);
  const selected = useRoomView((s) => s.local.selectedIds);
  const you = dice.you;
  const sends = useSends();
  const group = useRef<HTMLDivElement>(null);
  const caster = casterToken(view, spec.creature, sceneId);
  const template = spec.area ? view.templates[spec.area] : undefined;
  const named = props.named;
  const level = blockLevel({ level: spellLevel(named, spec.spell), rowSlot: props.rowSlot, picked: spec.slot });
  const slot = level?.value;
  const fromArea = template ? areaFill(dice, { spell: template.spell, casterId: caster?.id ?? template.casterId, label: template.label }, slot) : null;
  const fill = fromArea ?? (named ? actionFill(dice, named, { key: spec.key, ...(caster ? { tokenId: caster.id } : {}) }) : null);
  const rolls = named && named.damage.length > 0 ? damageRolls(named, { on: props.riders ?? new Set(), critical: false, creature: spec.creature }) : fill?.outcome.damage ? fillRolls(spec.spell, fill.outcome.damage, spec.creature) : [];
  const words = sendWords({ rolls, save: fill === null || fill.test.kind !== "none" });
  const entries = useAreaEntries(view, spec.area, sceneId);
  const targets = spec.area ? [] : selectionTargets(view, selected, caster?.id, sceneId);
  const targetNames = targets.map((id) => displayName(view.tokens[id]!));
  const reason = sendBlocked({ blocked: props.blocked, casterName: props.name, caster, targets: spec.area ? null : targets.length, waiting: waitingCount(view, you) });
  const sent = spec.sent ? sends[spec.sent] : undefined;
  const sentPhase = sent ? phaseOf(env.tracker.state(sent.id), view.casts[sent.id] !== undefined) : null;
  const preset = !spec.area && targets.length === 0 ? areaPresetOf(spec.spell) : undefined;

  const rollMenu = useRollModeMenu({
    source: JSON.stringify([spec, slot, rolls, targets, template, sceneId, props.riders ? [...props.riders] : [], sentPhase, panel.adv, panel.dis, panel.secret]),
    name: words.first,
    capability: { d20: false, visibility: rolls.length > 0 ? "selectable" : "request", damage: true },
    dm: you.role === "dm", disabled: reason !== null || sentPhase === "sending",
    valid: () => room.getState().connection === "open" && room.getState().sceneId === sceneId && room.getState().view === view && JSON.stringify(room.getState().local.selectedIds) === JSON.stringify(selected) && store.getState().cast === spec && ask() !== null && reason === null,
    fallbackFocus: () => props.opener?.current ?? group.current?.querySelector("button") ?? null,
    onTap: () => go(true), onRoll: (override) => go(true, override),
  });

  // Focus goes to its first button that takes a tap, which with no target yet is Cancel (6, Accessibility), once the panel has drawn, with the block brought into its scroll box: a phone's sheet opening on an area's ask starts at its top.
  // Only for a new opening, so a group reopened or a tab picked back keeps the focus on the control the viewer used (docs/design-v1-dice-pass.md 6.6).
  useEffect(() => {
    if (spec.opened !== undefined && store.getState().castFocused === spec.opened) return;
    const frame = requestAnimationFrame(() => {
      const box = group.current;
      if (!box) return;
      // Marked when it acts, not before: React's development double mount cancels the first frame.
      store.setState({ castFocused: spec.opened ?? 0 });
      // reveal.ts reads the DOM through a type of its own. The panel's scroller is not on the block's offset chain, so the block's foot is set from the head, as RollOptions sets its start.
      const scroller = scrollBox(box as unknown as Parameters<typeof scrollBox>[0]) as unknown as HTMLElement | null;
      if (scroller) {
        const r = box.getBoundingClientRect();
        const b = scroller.getBoundingClientRect();
        if (r.top < b.top || r.bottom > b.bottom) startInScrollBox(box, Math.max(theme.space(2), scroller.clientHeight - box.offsetHeight - theme.space(4)));
      }
      box.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const ask = () => {
    const now = room.getState().view;
    const at = now ? casterToken(now, spec.creature, sceneId) : undefined;
    if (!at || !now) return null;
    return askInput({ caster: at.id, sceneId: now.meta.playerSceneId ?? at.sceneId, spell: spec.spell, slot, area: spec.area, targets: spec.area ? [] : selectionTargets(now, room.getState().local.selectedIds, at.id, sceneId), roll: named?.key });
  };
  const go = (withRoll: boolean, override?: RollModeOverride) => {
    const input = ask();
    if (!input || reason !== null) return;
    const id = askFor(env, { key: spec.key, spell: spec.spell, ...(spec.roll !== undefined ? { roll: spec.roll } : {}), ...(spec.area !== undefined ? { area: spec.area } : {}), ask: input, rolls: withRoll ? rolls : null, ...(override ? { override } : {}) });
    if (id === null) return;
    store.setState((s) => (s.cast === spec ? { cast: { ...spec, sent: id } } : {}));
    props.onSent?.();
  };
  const again = () => {
    const input = ask();
    if (!sent || !input) return null;
    const id = askAgain(env, sent.id, input);
    if (id !== null) store.setState((s) => (s.cast === spec ? { cast: { ...spec, sent: id } } : {}));
    return id;
  };
  const cancel = () => store.setState((s) => (s.cast === spec ? { cast: null } : {}));
  const placeArea = () => {
    if (!preset || !sceneId) return;
    const scene = view.scenes[sceneId];
    if (!scene) return;
    const areaEnv = { actions, view, scene, role: you.role, youId: you.memberId, area };
    const from = resolvedChoice(areaEnv) ?? caster?.id ?? null;
    setDraft(areaEnv, presetDraft(preset, startDraft(areaEnv, from), from ?? undefined));
    ui.setTool("area");
    // The tool's bar shows only with no sheet open on a phone. The block stays, in the option store.
    ui.closeSheets();
  };

  const busy = sentPhase === "sending";
  const settledBadly = sent && (sentPhase === "refused" || sentPhase === "unknown");
  return (
    <div ref={group} role="group" aria-label={`Ask for saves: ${spec.spell}`} style={{ display: "grid", gap: theme.space(1), paddingTop: theme.space(1) }}>
      <div style={LINE}>{fillLine(fill, spec.spell, slot)}</div>
      <div aria-live="polite" style={LINE}>
        {entries !== null ? (
          <>
            <span style={{ color: theme.color.textMuted }}>In area{entries.length ? ` (${entries.length})` : ""}: </span>
            {inAreaText(entries)}
          </>
        ) : spec.area ? (
          "Its area is gone."
        ) : (
          targetsLine(targetNames)
        )}
      </div>
      {level?.own ? <OwnLevel spell={spec.spell} min={level.min} value={level.value} onChange={(n) => store.setState((s) => (s.cast === spec ? { cast: { ...spec, slot: n } } : {}))} /> : null}
      {settledBadly ? (
        <SendStatus send={sent} again={again} onClosed={cancel} />
      ) : (
        <>
          <div style={BUTTONS}>
            <Button {...rollMenu.buttonProps} aria-describedby={rollMenu.describe()} style={rollMenu.pressStyle} size="sm" variant="primary" busy={busy} disabled={reason !== null} title={reason ?? undefined}>
              {words.first}
            </Button>{rollMenu.menu}
            <Button size="sm" variant="quiet" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
          </div>
          {words.dmRolls ? (
            <div style={BUTTONS}>
              <Button size="sm" busy={busy} disabled={reason !== null} title={reason ?? undefined} onClick={() => go(false)}>
                {words.dmRolls}
              </Button>
            </div>
          ) : null}
          {/* With no target the targets line says what to do. */}
          {reason !== null && reason !== SELECT_TARGETS && !busy ? <Note>{reason}</Note> : null}
          {preset ? (
            <div style={BUTTONS}>
              <Button size="sm" onClick={placeArea}>
                Place its area
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The block's own casting level, for a leveled spell whose row has no stepper, as for Hold Person (3.1). */
function OwnLevel(props: { spell: string; min: number; value: number; onChange(n: number): void }) {
  const set = (n: number) => props.onChange(Math.max(props.min, Math.min(9, n)));
  return (
    <span role="group" aria-label={`Casting level for ${props.spell}`} style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1) }}>
      <Button size="sm" icon="minus" iconOnly="always" aria-label={`Casting level for ${props.spell}, lower`} disabled={props.value <= props.min} onClick={() => set(props.value - 1)} />
      <span aria-live="polite" style={{ minWidth: 48, textAlign: "center", fontSize: theme.font.body14, fontWeight: theme.weight.strong, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
        Level {props.value}
      </span>
      <Button size="sm" icon="plus" iconOnly="always" aria-label={`Casting level for ${props.spell}, higher`} disabled={props.value >= 9} onClick={() => set(props.value + 1)} />
    </span>
  );
}

/**
 * Every ask of the player's leading the Dice panel's options (3.2), named
 * for its caster when that is not the picked creature: the waiting ones
 * with Withdraw, the sends on their way, and those refused or unknown with
 * Ask again. They show with the panel scrolled off any row, for a caster
 * with no chip (a lent token off the players' scene) and for an area whose
 * spell has no row, after a reload or a replaced block too. The send an
 * open block shows in place is left to it while `blockDraws` says the
 * picked creature's options, and so the block, are drawn.
 */
export function WaitingAsks(props: { view: RoomState; pickedKey: string | null; blockDraws: boolean }) {
  const env = useCastEnv();
  const sends = useSends();
  const options = useOptionStore();
  const { store: folds } = useDiceFolds();
  // An open block shows its own send in place, but only while it draws: for the picked creature once its options draw, never with none to pick.
  const held = useOption((s) => (props.blockDraws && s.cast !== null && s.cast.key === props.pickedKey ? (s.cast.sent ?? null) : null));
  const lines = waitingLines(props.view, sends, (id) => env.tracker.state(id), held);
  if (lines.length === 0) return null;
  const casterName = (id: string) => {
    const token = props.view.tokens[id];
    if (!token) return "Your creature";
    return "ref" in token.actor ? (props.view.characters[token.actor.ref]?.name ?? displayName(token)) : displayName(token);
  };
  return (
    <div role="group" aria-label="Asks for saves" style={{ display: "grid", gap: theme.space(1) }}>
      {lines.map((line) => {
        const other = creatureKey(props.view, { tokenId: line.caster }) !== props.pickedKey;
        const caster = other ? casterName(line.caster) : undefined;
        const send = sends[line.id];
        if (line.phase === "asked") return <WaitingLine key={line.id} ask={{ id: line.id, spell: line.spell }} {...(caster ? { caster } : {})} />;
        if (line.phase !== "sending" && send) {
          const what = caster ? `${caster}'s ${line.spell}` : line.spell;
          // The open block whose send this is follows a retry and goes with a Close, so it never offers a second ask once its group opens again.
          return (
            <SendStatus
              key={line.id}
              send={send}
              lead={line.phase === "refused" ? `${what}: not asked.` : `${what}: the ask may have gone.`}
              again={() => retryFromList(env, options, line.id, (retryId) => markSendSeen(folds, foldKind(props.view, { tokenId: line.caster }), retryId))}
              onClosed={() => followSend(options, line.id, null)}
            />
          );
        }
        return (
          <div key={line.id} style={LINE}>
            {caster ? `${caster}'s ${line.spell}: asking` : `${line.spell}: asking`} the DM for saves…
          </div>
        );
      })}
    </div>
  );
}
