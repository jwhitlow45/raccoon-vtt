import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useStore } from "zustand";
import { CONDITION_KEYS, STATUS_KEYS, type Actor, type Effect, type LifeState } from "#shared/model.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { Button } from "../components/Button.tsx";
import { RETURN_RANK, useSheetReturnFocus } from "../components/sheetFocus.ts";
import { PaneHeader } from "../components/SheetHeader.tsx";
import { Tag } from "../components/Tag.tsx";
import { useLayoutSize } from "../features/device/layout.ts";
import { tokenAccess } from "../features/tokens/access.ts";
import { AltImagesRow } from "../features/tokens/AltImages.tsx";
import { DoorButton } from "../features/doors/DoorButton.tsx";
import { GroundNotice } from "../features/movement/GroundNotice.tsx";
import { LightChip } from "../features/vision/LightChip.tsx";
import { offersRequest } from "../features/rolls/logic.ts";
import { openAsk } from "../features/rolls/open.ts";
import { EffectIcon } from "../features/tokens/EffectIcon.tsx";
import { duplicateToken, occupiedBoxes, spreadPositions } from "../features/tokens/factory.ts";
import {
  conditionLit,
  conditionOps,
  deleteButtonWords,
  deleteManyOps,
  elevationOps,
  fightCandidates,
  fightOps,
  flagLit,
  flagPatch,
  groupCreatures,
  groupOffers,
  sharedElevation,
  updateManyOps,
  type Lit,
} from "../features/tokens/groupEdit.ts";
import { GroupHpEntry } from "../features/tokens/GroupHpEntry.tsx";
import { GroupMoreSheet } from "../features/tokens/GroupMoreSheet.tsx";
import { DeathSaves, HpEntry, oneTarget } from "../features/tokens/HpSection.tsx";
import { pathNow } from "../features/measure/movement.ts";
import { lastMoveSlot, offered, offersMarkUndo, offersUndo, undoOf } from "../features/tokens/undoMove.ts";
import { useTopBars } from "../features/encounter/band.ts";
import type { Point, Size } from "../lib/camera.ts";
import { displayName, footprint, type ViewToken } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { effectChip, elevationBadge, hpDisplay, hpText } from "../lib/tokenView.ts";
import { foldsUnderSheet, usePublishBar } from "../pages/fold.ts";
import { dispatchGesture } from "../state/actions.ts";
import { useRoomScope, useScoped } from "../state/scope.ts";
import { sheetOpen } from "../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";

const BAR_WIDTH = 304;
const NO_CHARACTERS = {};
/** Below the token's name label, which hangs about 30 px under the footprint. */
const OFFSET_Y = 34;
/** Room above the token's bottom edge for the token itself when the bar flips above it. */
const FLIP_CLEARANCE = 40;
const MARGIN = theme.space(2);
/**
 * The canvas runs under the room's top bar and bottom toolbar (plus the
 * safe areas, client/pages/Room.tsx), so the bar keeps clear of both, with
 * a small gap, or its buttons would sit under theirs. On a phone in a fight
 * the turn band hangs under the top bar too (features/encounter/band.ts).
 */
const TOP_GAP = 12;
const BOTTOM_RESERVE = theme.layout.toolbar + 16;

type Drawer = "conditions" | null;

/**
 * The bar that opens under a tapped token (design section 14.3): the
 * token's HP and effects at a glance, quick HP entry, condition toggles,
 * elevation, and for the DM hide, lock, duplicate and delete. Everything
 * else is one tap away in Details.
 *
 * It lists every effect with its full name, since the chips on the token
 * itself overflow into "+N".
 */
export function TokenActionBar(props: {
  token: ViewToken;
  anchor: Point;
  /** The token's footprint on screen, so a bar too tall for above or below can sit beside it. */
  tokenSize?: Size;
  viewport: Size;
  /** Room the "Select several" bar takes above the toolbar, in pixels. */
  reserveBottom?: number;
  fullAccess: boolean;
  onDetails(): void;
  onClose(): void;
}) {
  const { token } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  const you = useRoomView((s) => s.you);
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const playersApplyDamage = useRoomView((s) => s.view?.meta.settings.playersApplyDamage ?? false);
  const scene = useRoomView((s) => s.view?.scenes[token.sceneId]);
  const tokens = useRoomView((s) => s.view?.tokens);
  const multi = useRoomView((s) => s.local.multi);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const scope = useRoomScope();
  // Only a creature a player plays, askable where it stands, offers a roll request (docs/design-v1-dm-tools.md 3.3, rolls/logic.ts askTarget).
  const played = useRoomView((s) => (s.view ? offersRequest(s.view, [token]) : false));

  const access = useMemo(
    () =>
      tokenAccess({
        role: you?.role ?? "player",
        memberId: you?.memberId,
        view: { characters: character ? { [character.id]: character } : {}, meta: { settings: { playersApplyDamage } } },
        token,
      }),
    [you, character, playersApplyDamage, token],
  );
  const actor: Partial<Actor> | undefined = "inline" in token.actor ? token.actor.inline : character?.actor;
  const effects = actor?.effects ?? [];
  const hp = hpDisplay({ actor, hpVisibility: token.hpVisibility, fullAccess: props.fullAccess || access.full });
  const badge = elevationBadge(token.elevation);
  const target = { tokenId: token.id };
  const life = actor?.life ?? "alive";
  const atZero = actor?.hp?.cur === 0 && (life === "dying" || life === "stable");
  // A label already says Dying or Dead, so the life state stands in for it rather than beside it.
  const hpLine = hp.kind === "label" ? (LIFE_WORD[life] || hp.label) : hpText(hp) ? `HP ${hpText(hp)}` : null;
  const lifeChip = hp.kind === "label" ? "" : LIFE_WORD[life];

  const toggleEffect = (key: Effect["key"]) => {
    const existing = effects.find((e) => e.key === key);
    if (existing) actions.dispatch({ t: "actor.effect.remove", target, effectId: existing.id });
    else actions.dispatch({ t: "actor.effect.add", target, effect: { id: actions.newId(), key, ...(key === "exhaustion" ? { level: 1 } : {}) } });
  };

  const duplicate = () => {
    if (!scene) return;
    const fp = footprint(token);
    const occupied = occupiedBoxes(Object.values(tokens ?? {}), token.sceneId);
    const [at] = spreadPositions({ center: { x: token.x + fp.w / 2, y: token.y + fp.h / 2 }, footprint: fp, count: 1, bounds: scene.bounds, occupied });
    const id = actions.newId();
    const chunks = store.getState().view?.buildChunks ?? {};
    if (actions.dispatch({ t: "token.create", token: duplicateToken(token, { id, at: at ?? { x: token.x + fp.w, y: token.y }, chunks }) }) !== null) {
      ui.select(id);
    }
  };

  return (
    <BarFrame
      anchor={props.anchor}
      tokenSize={props.tokenSize}
      viewport={props.viewport}
      reserveBottom={props.reserveBottom}
      label={`${displayName(token)} actions`}
      dock={{ text: displayName(token), show: `Show ${displayName(token)} actions`, closeLabel: "Close", close: props.onClose }}
    >
      <PaneHeader
        // The whole name, wrapped: the token's plate on the map steps aside while the bar shows it (Stage.tsx).
        title={<span style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{displayName(token)}</span>}
        actions={badge ? <span style={{ flex: "none", color: theme.color.accentSoft, fontWeight: theme.weight.bold }}>{badge} ft</span> : null}
        onClose={props.onClose}
      />
      {hpLine || lifeChip ? (
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: theme.space(2), color: theme.color.textMuted }}>
          {hpLine ? <span>{hpLine}</span> : null}
          {lifeChip ? <Tag tone={life === "stable" ? "warning" : "danger"}>{lifeChip}</Tag> : null}
        </div>
      ) : null}
      {life === "dying" && access.deathSaves && actor?.deathSaves ? (
        <DeathSaves
          saves={actor.deathSaves}
          canEdit
          onChange={(ok, fail) => actions.dispatch({ t: "actor.deathSave", target, ok, fail })}
        />
      ) : null}
      {effects.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
          {effects.map((effect) => (
            <li
              key={effect.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: theme.space(1.5),
                padding: `${theme.space(0.5)}px ${theme.space(2)}px ${theme.space(0.5)}px ${theme.space(0.5)}px`,
                borderRadius: theme.radius.pill,
                background: theme.color.surfaceRaised,
                fontSize: theme.font.small,
              }}
            >
              <EffectIcon effect={effect} size={20} />
              {effectChip(effect).label}
              {effect.hiddenFromPlayers ? <span style={{ color: theme.color.textMuted }}>(hidden)</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {access.hp !== "none" ? <HpEntry targets={[oneTarget(target, access.hp, atZero)]} access={access.hp} /> : null}

      {access.canEditToken("elevation") ? (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
          <span style={{ flex: 1, color: theme.color.textMuted }}>Elevation</span>
          <BarButton label="Down 5 feet" onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { elevation: (token.elevation ?? 0) - 5 } })}>
            −5
          </BarButton>
          <span style={{ minWidth: 56, textAlign: "center", fontWeight: theme.weight.bold }}>{token.elevation ?? 0} ft</span>
          <BarButton label="Up 5 feet" onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { elevation: (token.elevation ?? 0) + 5 } })}>
            +5
          </BarButton>
        </div>
      ) : null}

      <GroundNotice token={token} />

      {access.canEditToken("altImages") ? (
        <AltImagesRow
          token={token}
          aspect={footprint(token).w / footprint(token).h}
          onPatch={(patch) => actions.dispatch({ t: "token.update", tokenId: token.id, patch })}
        />
      ) : null}

      {drawer === "conditions" ? <QuickConditions lit={(key) => (effects.some((e) => e.key === key) ? "all" : "none")} onToggle={toggleEffect} /> : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        <UndoMoveButton tokenIds={[token.id]} />
        {access.dm || access.owner ? <CountLegButton token={token} /> : null}
        <DoorButton token={token} />
        {access.effects ? (
          <BarButton pressed={drawer === "conditions"} onClick={() => setDrawer((d) => (d === "conditions" ? null : "conditions"))}>
            Conditions
          </BarButton>
        ) : null}
        {/* Toggles named for the state they are in, lit while it holds, so a lit button never reads as the opposite. */}
        {access.canEditToken("light") ? <LightChip token={token} /> : null}
        {access.dm ? (
          <BarButton
            pressed={token.visibility === "dm"}
            onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { visibility: token.visibility === "dm" ? "all" : "dm" } })}
          >
            Hidden
          </BarButton>
        ) : null}
        {access.dm ? (
          <BarButton
            pressed={token.locked}
            onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { locked: !token.locked } })}
          >
            Locked
          </BarButton>
        ) : null}
        {access.dm && played ? <BarButton onClick={() => openAsk(scope, { kind: "selection", tokenIds: [token.id] })}>Request a roll</BarButton> : null}
        {access.dm ? <BarButton onClick={duplicate}>Duplicate</BarButton> : null}
        {access.dm ? (
          <DeleteButton
            onDelete={() => {
              actions.dispatch({ t: "token.delete", tokenId: token.id });
              props.onClose();
            }}
          />
        ) : null}
        <BarButton pressed={multi} onClick={() => ui.setMultiSelect(!multi)}>
          Select several
        </BarButton>
        <BarButton grow onClick={props.onDetails}>
          Details
        </BarButton>
      </div>
    </BarFrame>
  );
}

/**
 * The bar for several selected tokens (features sections 5 and 10, and
 * docs/design-v1-dm-tools.md 3.5): who is in the group, one HP entry for
 * all of them, dragging any of them moves the group (lib/group.ts), and the
 * edits that make sense for a group: conditions and elevation, and for the
 * DM Hidden, Locked, Add to the fight, Delete and More. An action shows only
 * when the viewer may apply it to every selected token, so nothing here is
 * refused. Each tap is one undo step.
 */
export function GroupActionBar(props: {
  tokens: readonly ViewToken[];
  /** How many of them this member may move: a drag moves only those. */
  movable: number;
  anchor: Point;
  /** The token's footprint on screen, so a bar too tall for above or below can sit beside it. */
  tokenSize?: Size;
  viewport: Size;
  reserveBottom?: number;
  onClose(): void;
}) {
  const { tokens } = props;
  const ui = useRoomUi();
  const actions = useRoomActions();
  const multi = useRoomView((s) => s.local.multi);
  const you = useRoomView((s) => s.you);
  const characters = useRoomView((s) => s.view?.characters ?? NO_CHARACTERS);
  const playersApplyDamage = useRoomView((s) => s.view?.meta.settings.playersApplyDamage ?? false);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [more, setMore] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const offers = useMemo(
    () => groupOffers(tokens, { role: you?.role ?? "player", memberId: you?.memberId, characters, playersApplyDamage }),
    [tokens, you, characters, playersApplyDamage],
  );
  const creatures = useMemo(() => groupCreatures(tokens, characters), [tokens, characters]);
  const elevation = sharedElevation(tokens);
  const ids = tokens.map((t) => t.id);
  const send = (ops: readonly ClientOp[]) => {
    if (ops.length > 0) dispatchGesture(actions, ops);
  };
  const hidden = flagLit(tokens, "hidden");
  const locked = flagLit(tokens, "locked");
  const outOfFight = fightCandidates(tokens, encounter).length;
  const scope = useRoomScope();
  const anyPlayed = useRoomView((s) => (s.view ? offersRequest(s.view, tokens) : false));

  return (
    <BarFrame
      anchor={props.anchor}
      tokenSize={props.tokenSize}
      viewport={props.viewport}
      reserveBottom={props.reserveBottom}
      label={`${tokens.length} selected tokens`}
      dock={{ text: `${tokens.length} selected`, show: `Show actions for ${tokens.length} selected tokens`, closeLabel: "Let go of all of them", close: props.onClose }}
    >
      <PaneHeader title={`${tokens.length} selected`} onClose={props.onClose} closeLabel="Let go of all of them" />
      <div style={{ color: theme.color.textMuted, overflowWrap: "anywhere" }}>{tokens.map((t) => displayName(t)).join(", ")}</div>
      <GroupHpEntry tokens={tokens} />
      {props.movable >= 2 ? (
        <div style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
          {props.movable === tokens.length ? "Drag any of them to move them all." : `A drag moves the ${props.movable} of them you may move.`}
        </div>
      ) : null}
      {offers.elevation ? (
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
          <span style={{ flex: 1, color: theme.color.textMuted }}>Elevation</span>
          <BarButton label="All down 5 feet" onClick={() => send(elevationOps(tokens, -5))}>
            −5
          </BarButton>
          <span style={{ minWidth: 56, textAlign: "center", fontWeight: theme.weight.bold }}>{elevation === null ? "Mixed" : `${elevation} ft`}</span>
          <BarButton label="All up 5 feet" onClick={() => send(elevationOps(tokens, 5))}>
            +5
          </BarButton>
        </div>
      ) : null}
      {drawer === "conditions" && offers.conditions ? (
        <QuickConditions lit={(key) => conditionLit(creatures, key)} onToggle={(key) => send(conditionOps(creatures, key, actions.newId))} />
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
        <UndoMoveButton tokenIds={ids} />
        {offers.conditions ? (
          <BarButton pressed={drawer === "conditions"} onClick={() => setDrawer((d) => (d === "conditions" ? null : "conditions"))}>
            Conditions
          </BarButton>
        ) : null}
        {offers.dm && anyPlayed ? <BarButton onClick={() => openAsk(scope, { kind: "selection", tokenIds: ids })}>Request a roll</BarButton> : null}
        {offers.dm ? (
          <BarButton pressed={hidden === "all"} half={hidden === "some"} onClick={() => send(updateManyOps(ids, flagPatch(tokens, "hidden")))}>
            Hidden
          </BarButton>
        ) : null}
        {offers.dm ? (
          <BarButton pressed={locked === "all"} half={locked === "some"} onClick={() => send(updateManyOps(ids, flagPatch(tokens, "locked")))}>
            Locked
          </BarButton>
        ) : null}
        {offers.dm && outOfFight > 0 ? (
          <BarButton onClick={() => send(fightOps(tokens, encounter, actions.newId))}>{encounter ? "Add to the fight" : "Start a fight"}</BarButton>
        ) : null}
        {offers.dm ? (
          <BarButton ref={moreButton} onClick={() => setMore(true)}>
            More
          </BarButton>
        ) : null}
        {offers.dm ? (
          <DeleteButton
            armedText={`Delete ${tokens.length} tokens?`}
            onDelete={() => {
              send(deleteManyOps(ids));
              props.onClose();
            }}
          />
        ) : null}
        <BarButton pressed={multi} onClick={() => ui.setMultiSelect(!multi)}>
          Select several
        </BarButton>
        <BarButton onClick={props.onClose}>Clear</BarButton>
      </div>
      {more ? <GroupMoreSheet tokens={tokens} opener={moreButton} onClose={() => setMore(false)} /> : null}
    </BarFrame>
  );
}

/**
 * A player's way to take back the moves they just made with a finger
 * (features 13), newest first, shown while the move is the newest change of
 * theirs this device knows of (undoMove.ts). The server answers with what
 * it undid, or that the move is no longer the newest step when another
 * device changed the stack meanwhile.
 */
function UndoMoveButton(props: { tokenIds: readonly string[] }) {
  const actions = useRoomActions();
  const offer = useStore(useScoped(lastMoveSlot), offered);
  if (!offer || !offersUndo(offer, props.tokenIds)) return null;
  return (
    <BarButton label="Undo your last move" onClick={() => actions.dispatch(undoOf(offer))}>
      Undo move
    </BarButton>
  );
}

/**
 * "Doesn't count" (features section 4), for the DM and the creature's
 * owners, on the active creature once it has moved this turn: its last
 * move, such as a shove, Misty Step or a teleport, stops counting against
 * its speed and the trail draws it faint. Lit while it does not count, and
 * a press on it lit counts it again. A player's own mark, while this
 * device knows it is their newest change, is taken back with an undo
 * instead, so the move's own "Undo move" is offered again after it.
 */
function CountLegButton(props: { token: ViewToken }) {
  const actions = useRoomActions();
  const role = useRoomView((s) => s.you?.role ?? "player");
  const encounter = useRoomView((s) => s.view?.encounter);
  const slot = useScoped(lastMoveSlot);
  const offer = useStore(slot, offered);
  const undoing = useStore(slot, (s) => s.undoing !== null);
  const path = pathNow(encounter, props.token, role);
  const last = path && path.stops.length >= 2 ? path.stops[path.stops.length - 1] : undefined;
  if (!last) return null;
  const off = last.uncounted === true;
  const press = () => {
    // The bar's undo waits for the server, and a second press meanwhile would act on a mark about to change.
    if (undoing) return;
    if (offer && offersMarkUndo(offer, props.token.id)) actions.dispatch(undoOf(offer));
    else actions.dispatch({ t: "token.countLeg", tokenId: props.token.id, counts: off });
  };
  return (
    <BarButton pressed={off} label="The last move doesn't count against speed, for a shove or a teleport" onClick={press}>
      Doesn't count
    </BarButton>
  );
}

/**
 * Where a bar hangs: below its token when it fits, else above it. When it
 * fits neither, as on a desktop with the token low on an 800 px screen, it
 * moves beside the token if the screen is wide enough, with the whole
 * height to use. Otherwise it takes the side with more room and scrolls
 * inside, with a "Scroll for more" fade at the bottom while anything is
 * hidden, so Duplicate or Delete never sit out of view without a hint.
 *
 * On a phone in portrait it spans the screen with small side margins,
 * since a 304 px card left a gap at the right that fit nothing. In
 * landscape an open sheet docks on the right, and the bar stops at the
 * sheet's left edge instead of passing under it.
 *
 * Under a portrait sheet it folds (pages/fold.ts, docs/design-v1-visual.md
 * 3.2.1): the frame takes the `hidden` attribute, which the global
 * `[hidden]` rule keeps over the body's inline `display: grid`, so its
 * controls leave the focus order and the accessibility tree while the body
 * stays mounted. A half-typed HP entry, the chosen HP mode, an open
 * Conditions drawer and an armed Delete all survive the fold. Meanwhile the
 * dock on the sheet's edge shows the bar's name with Show and Close
 * (`dock`), and once the sheet closes the frame is where focus returns,
 * after a roll card the sheet was hiding (components/sheetFocus.ts).
 */
function BarFrame(props: {
  anchor: Point;
  tokenSize?: Size;
  viewport: Size;
  reserveBottom?: number;
  label: string;
  dock: { text: string; show: string; closeLabel: string; close(): void };
  children: ReactNode;
}) {
  const { anchor } = props;
  const layout = useLayoutSize();
  const anySheet = useRoomView((s) => sheetOpen(s.local));
  const folded = foldsUnderSheet({ ...layout, sheetOpen: anySheet });
  const phone = layout.width < theme.layout.wideMinWidth;
  const portrait = phone && layout.width <= layout.height;
  const sheetWidth = phone && !portrait && anySheet ? Math.min(theme.layout.landscapeSheetWidth, props.viewport.width * 0.6) : 0;
  const viewport = sheetWidth > 0 ? { width: props.viewport.width - sheetWidth, height: props.viewport.height } : props.viewport;
  const reserveBottom = BOTTOM_RESERVE + (props.reserveBottom ?? 0);
  const topReserve = useTopBars() + TOP_GAP;
  const barRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(160);
  const [clipped, setClipped] = useState(false);
  useSheetReturnFocus(barRef, RETURN_RANK.tokenBar);
  usePublishBar({ label: props.label, ...props.dock, frame: barRef });
  const measure = () => {
    const el = barRef.current;
    const content = contentRef.current;
    // Folded, the bar has no size: it keeps the last one it had, for where it unfolds.
    if (!el || !content || content.offsetHeight === 0) return;
    setBarHeight(content.offsetHeight + 2);
    setClipped(el.scrollHeight - el.clientHeight - el.scrollTop > 4);
  };
  // One wrapper holds every section, so a section that opens after the bar does (the conditions drawer, death saves) resizes it too.
  useLayoutEffect(() => {
    const el = barRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  const width = portrait ? viewport.width - 2 * MARGIN : Math.min(BAR_WIDTH, viewport.width - 2 * MARGIN);
  const tokenW = props.tokenSize?.width ?? 0;
  const tokenH = props.tokenSize?.height ?? 0;
  const topBelow = Math.max(topReserve, anchor.y + OFFSET_Y);
  const spaceBelow = viewport.height - reserveBottom - topBelow;
  const bottomAbove = Math.max(reserveBottom, viewport.height - anchor.y + OFFSET_Y + FLIP_CLEARANCE);
  const spaceAbove = viewport.height - bottomAbove - topReserve;
  const spaceSide = viewport.height - topReserve - reserveBottom;
  const rightLeft = anchor.x + tokenW / 2 + MARGIN;
  const leftLeft = anchor.x - tokenW / 2 - MARGIN - width;
  const sideLeft = portrait ? null : rightLeft + width <= viewport.width - MARGIN ? rightLeft : leftLeft >= MARGIN ? leftLeft : null;
  const beside = barHeight > Math.max(spaceBelow, spaceAbove) && sideLeft !== null && spaceSide > Math.max(spaceBelow, spaceAbove);
  const below = !beside && (barHeight <= spaceBelow || spaceBelow >= spaceAbove);
  const left = beside ? sideLeft! : Math.min(Math.max(MARGIN, anchor.x - width / 2), viewport.width - width - MARGIN);
  const sideTop = Math.min(Math.max(topReserve, anchor.y - tokenH / 2 - barHeight / 2), viewport.height - reserveBottom - Math.min(barHeight, spaceSide));
  const maxHeight = Math.max(120, beside ? spaceSide : below ? spaceBelow : spaceAbove);
  return (
    <div
      ref={barRef}
      role="dialog"
      aria-label={props.label}
      hidden={folded}
      // Focusable from script, not by Tab: the dock's Show and a closing sheet move focus here, which announces the bar and opens no keyboard.
      tabIndex={-1}
      onScroll={measure}
      style={{
        position: "absolute",
        left,
        // The reserves above leave out the safe areas, which only CSS can read, so CSS adds them.
        top: beside ? `max(${sideTop}px, calc(${theme.safe.top} + ${topReserve}px))` : below ? `max(${topBelow}px, calc(${theme.safe.top} + ${topReserve}px))` : undefined,
        bottom: beside || below ? undefined : `max(${bottomAbove}px, calc(${theme.safe.bottom} + ${reserveBottom}px))`,
        width,
        maxHeight: `max(120px, calc(${maxHeight}px - ${theme.safe.top} - ${theme.safe.bottom}))`,
        overflowY: "auto",
        overscrollBehavior: "contain",
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        boxShadow: theme.shadow.pane,
        color: theme.color.text,
        fontSize: theme.font.body14,
        zIndex: theme.z.pane,
      }}
    >
      <div
        ref={contentRef}
        style={{
          padding: `${theme.space(1)}px ${theme.space(3)}px ${theme.space(3)}px`,
          display: "grid",
          // One column no wider than the bar: an auto column grows to its widest unbreakable child, such as a long name, and pushes the buttons out of view.
          gridTemplateColumns: "minmax(0, 1fr)",
          gap: theme.space(2),
        }}
      >
        {props.children}
      </div>
      {clipped ? (
        // No height of its own, so the hint never adds to what scrolls: it is laid over the bar's bottom edge.
        <div aria-hidden style={{ position: "sticky", bottom: 0, height: 0, pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              padding: `${theme.space(6)}px ${theme.space(3)}px ${theme.space(2)}px`,
              background: `linear-gradient(transparent, ${theme.color.surface} 60%)`,
              color: theme.color.textMuted,
              fontSize: theme.font.small,
              textAlign: "center",
            }}
          >
            Scroll for more
          </div>
        </div>
      ) : null}
    </div>
  );
}

const LIFE_WORD: Record<LifeState, string> = { alive: "", dying: "Dying", stable: "Stable", dead: "Dead" };

/**
 * One tap adds or removes. Each button shows its name under the icon,
 * since a touch screen has no hover to read a title from. Levels, spells,
 * durations and the rules text live in Details, so the bar, which loads
 * with the map for everyone, carries no SRD text.
 */
function QuickConditions(props: { lit(key: Effect["key"]): Lit; onToggle(key: Effect["key"]): void }) {
  const group = (title: string, keys: readonly Effect["key"][]) => (
    <div role="group" aria-label={title} style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{title}</div>
      {/* Three across leaves room for the longest names ("Incapacitated") on one line at the bar's 304 px. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))", gap: theme.space(1) }}>
        {keys.map((key) => {
          const lit = props.lit(key);
          const active = lit === "all";
          // Half lit: some of a group have it. A dashed edge, so it never reads as on or off by color alone.
          const some = lit === "some";
          const name = effectChip({ key }).label;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={some ? "mixed" : active}
              onClick={() => props.onToggle(key)}
              style={{
                minHeight: 50,
                display: "grid",
                justifyItems: "center",
                alignContent: "center",
                gap: theme.space(0.5),
                padding: `${theme.space(1)}px ${theme.space(0.5)}px`,
                borderRadius: theme.radius.sm,
                border: `${theme.line.strong}px ${some ? "dashed" : "solid"} ${active || some ? theme.color.accent : "transparent"}`,
                background: active ? theme.color.accentTint : theme.color.surfaceRaised,
                color: active || some ? theme.color.text : theme.color.textMuted,
                fontSize: theme.font.tiny,
                fontWeight: theme.weight.strong,
                lineHeight: 1.15,
                cursor: "pointer",
              }}
            >
              <EffectIcon effect={{ key }} size={22} />
              {name}
            </button>
          );
        })}
      </div>
    </div>
  );
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {group("Conditions", CONDITION_KEYS)}
      {group("Other statuses", STATUS_KEYS)}
    </div>
  );
}

function DeleteButton(props: { onDelete(): void; armedText?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const words = deleteButtonWords(armed, props.armedText);
  return (
    <BarButton
      danger
      armed={armed}
      label={words.label}
      onClick={() => {
        if (armed) props.onDelete();
        else setArmed(true);
      }}
    >
      {words.text}
    </BarButton>
  );
}

/**
 * The bar's small buttons (components/Button.tsx, `sm`). `half` is a
 * toggle that holds for some of a group and not all, such as Hidden for
 * two of three tokens: `aria-pressed="mixed"` and a dashed accent edge, so
 * it never reads as on or off by color alone.
 */
function BarButton(props: {
  ref?: Ref<HTMLButtonElement>;
  onClick(): void;
  children: ReactNode;
  label?: string;
  pressed?: boolean;
  half?: boolean;
  danger?: boolean;
  armed?: boolean;
  grow?: boolean;
}) {
  return (
    <Button
      ref={props.ref}
      size="sm"
      variant={props.danger ? "danger" : "secondary"}
      armed={props.armed}
      pressed={props.half ? undefined : props.pressed}
      aria-pressed={props.half ? "mixed" : props.pressed}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      style={{
        flex: props.grow ? "1 0 auto" : "none",
        ...(props.half ? { background: theme.color.surfaceRaised, border: `${theme.line.border}px dashed ${theme.color.accent}`, color: theme.color.text } : null),
      }}
    >
      {props.children}
    </Button>
  );
}
