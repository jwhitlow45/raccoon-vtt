import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject } from "react";
import { useStore } from "zustand";
import { healRevivesDead } from "#shared/migrate.ts";
import { CONDITION_KEYS, STATUS_KEYS, type Actor, type Effect, type Token } from "#shared/model.ts";
import { stopFootprint } from "#shared/rules/footprint.ts";
import { hpLess, shownLife } from "#shared/rules/hp.ts";
import { reshapeLeg } from "#shared/rules/path.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { Button, ButtonGhost } from "../components/Button.tsx";
import { RETURN_RANK, useSheetReturnFocus } from "../components/sheetFocus.ts";
import { Icon, type IconName } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { useTooltip } from "../components/Tooltip.tsx";
import { GRIP_ATTR, PaneHeader, STICKY_HEADER_ATTR, type PaneHandle } from "../components/SheetHeader.tsx";
import { useLayoutSize } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { useOptionStore } from "../features/dice/optionState.ts";
import { UsesDrawer, useUsesPresence } from "../features/combat/CombatUses.tsx";
import { useFightJoin } from "../features/combat/state.ts";
import { SrdLoadFailed } from "../features/monsters/SrdLoadFailed.tsx";
import { useGroupSaveStore } from "../features/dice/groupSave/store.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { ViewAsButton } from "../features/dm/viewAs.tsx";
import { useSend } from "../features/encounter/hooks.ts";
import { tokenAccess } from "../features/tokens/access.ts";
import { AltImagesRow } from "../features/tokens/AltImages.tsx";
import { DoorButton } from "../features/doors/DoorButton.tsx";
import { GroundNotice } from "../features/movement/GroundNotice.tsx";
import { LightChip } from "../features/vision/LightChip.tsx";
import { AttachButton } from "../features/attach/AttachButton.tsx";
import { DetachButton, DetachNote, GroupLine, useAttachSlots, useDetach } from "../features/attach/BarParts.tsx";
import { offersRequest } from "../features/rolls/logic.ts";
import { openAsk } from "../features/rolls/open.ts";
import { EffectIcon } from "../features/tokens/EffectIcon.tsx";
import { DefenseLines, MoreStats, SavesLine, useLinkedBlock, VitalsLine } from "../features/tokens/StatSummary.tsx";
import { openStatBlock } from "../features/tokens/statBlockOpen.ts";
import { shortSplit, vitals } from "../features/tokens/statSummary.ts";
import { opensStatBlock, statBlockShown, tokenStatBlock } from "../features/monsters/statBlockLink.ts";
import { visionOn } from "../features/vision/sightMode.ts";
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
  shownRowOps,
  updateManyOps,
  type Lit,
} from "../features/tokens/groupEdit.ts";
import { deadHealLine } from "../features/tokens/groupHp.ts";
import { GroupHpEntry } from "../features/tokens/GroupHpEntry.tsx";
import { GroupMoreSheet } from "../features/tokens/GroupMoreSheet.tsx";
import { DeathSaves, HpEntry, oneTarget } from "../features/tokens/HpSection.tsx";
import { pathNow } from "../features/measure/movement.ts";
import { customWords, SIZE_WORDS, stepSize } from "../features/tokens/resize.ts";
import { useDuplicate, type DuplicateFocus } from "../features/tokens/useDuplicate.ts";
import { useResize } from "../features/tokens/useResize.ts";
import { REVIVE_NOTE, ReviveButton, offersRevive } from "../features/tokens/Revive.tsx";
import { barTokenIds, lastMoveSlot, offered, offersMarkUndo, offersUndo, undoOf } from "../features/tokens/undoMove.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { handFocusOn } from "../lib/handFocus.ts";
import { bodyHoldsField, useTypingWithin } from "../lib/keyboardInset.ts";
import type { Point, Size } from "../lib/camera.ts";
import { TAP_SLOP_PX } from "../lib/gestures.ts";
import { displayName, footprint, type ViewToken } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { effectChip, elevationBadge } from "../lib/tokenView.ts";
import { dockSlot, foldsUnderSheet, sideSheetRoom, usePublishBar } from "../pages/fold.ts";
import { dispatchGesture } from "../state/actions.ts";
import { useRoomScope, useScoped } from "../state/scope.ts";
import { sheetOpen } from "../state/types.ts";
import {
  anchoredSpot,
  arrowStep,
  barDockSlot,
  barChrome,
  clampMove,
  clearShift,
  DEFAULT_SPOT,
  expandedRoom,
  expandOffered,
  freeArea,
  handleCorner,
  hangBox,
  hasSize,
  headAsksToasts,
  headerLayout,
  heldOrOpenMode,
  heldPlace,
  isDefaultSpot,
  keySize,
  keySpot,
  laneLeft,
  limitMet,
  NO_SIZE,
  placeBar,
  releaseSize,
  releaseSpot,
  RESET_WORDS,
  resizeBox,
  resizeLimits,
  REST_HEIGHT,
  REST_TIGHT,
  sizeWords,
  spanToastSlot,
  spotWords,
  stripSqueezed,
  writeSize,
  writeSpot,
  type BarFacts,
  type BarMode,
  type BarSize,
  type Box,
  type Corner,
  type HeaderSummary,
  type ResizeLimits,
  type ResizePart,
  type RestState,
  type Spot,
} from "./barDock.ts";
import { barButtons, barShort, isCompanion, type BarButtonId } from "./barButtons.ts";
import { groupRestButtons, restButtons, restStatus, type EntryStatus, type RestFit, type RestStatus } from "./barButtons.ts";
import { RestRow, type RestItem } from "./RestRow.tsx";
import { NOTE_INSET } from "./barDock.ts";
import { unitText, type VitalItem } from "../features/tokens/statSummary.ts";
import { useGroupHp } from "../features/tokens/GroupHpEntry.tsx";
import type { HpRest } from "../features/tokens/HpSection.tsx";
import { useRoomActions, useRoomUi, useRoomView } from "../state/view.ts";

const NO_CHARACTERS = {};

/** A row of the bar's buttons, wrapping. An empty one takes no room (globals.css). */
const BUTTON_ROW = { display: "flex", flexWrap: "wrap", gap: theme.space(1) } as const;

/**
 * A button in one of the bar's rows grows to share its line
 * (docs/design-v1-polish.md R6), as the HP entry's Damage, Heal, Set and
 * Temp fill theirs, so the last of a row that wraps, such as Attach or
 * Delete, never stands alone at its own width. The buttons the bar takes
 * from other features (Attach, Get off, a door's, Light) stand only in
 * these rows, so they take this flex themselves.
 */
const ROW_BUTTON_FLEX = "1 1 auto";

/** Whether a button stands in one of the bar's rows (ButtonRow), and so grows to share its line. */
const InButtonRow = createContext(false);

function ButtonRow(props: { row: "passing" | "play" | "less"; children: ReactNode }) {
  return (
    <div data-bar-row={props.row} style={BUTTON_ROW}>
      <InButtonRow.Provider value={true}>{props.children}</InButtonRow.Provider>
    </div>
  );
}

type Drawer = "conditions" | "uses" | null;

/**
 * Where focus goes once Revive leaves the bar: its frame, which announces
 * the bar, as the dock's Show does. The HP field would take Ctrl+Z from the
 * room's undo, which takes the Revive back, and open a phone's keyboard.
 */
const REVIVE_FOCUS_IN_BAR = { scope: '[role="dialog"]', to: [":scope"] } as const;

/** The bar's frame, which holds one token's or a group's bar at a time and takes focus from script. */
const BAR_FRAME = '[role="dialog"][data-bar-mode]';

/** Where focus goes once Duplicate replaced the bar with the copy's: the frame that stands then, a new one. */
const DUPLICATE_FOCUS_IN_BAR: DuplicateFocus = { scope: "body", to: [BAR_FRAME] };

/**
 * The bar that opens under a tapped token (design section 14.3), in the
 * order docs/design-v1-token-panel.md 3.3 ranks by use: the header, the
 * stat summary's vitals (AC, HP, speed, Passive Perception), the HP entry
 * right after them, death saves, the effects, a linked block's saves and
 * defenses, then "Stat block" and Details beside the
 * summary they expand, elevation, other images, the Conditions drawer,
 * and the buttons in rows (barButtons.ts): the answers to the move just
 * made while they show, what play needs, then setup and Delete apart from
 * it. On a short bar (barButtons.ts barShort) the vitals keep
 * to AC and HP, the HP entry puts its field and Apply first, and "More
 * stats" holds the rest, so Apply shows without a scroll on a phone held
 * sideways.
 *
 * It lists every effect with its full name, since the chips on the token
 * itself overflow into "+N".
 */
export function TokenActionBar(props: {
  token: ViewToken;
  anchor: Point;
  /** The map's size in the chrome's own pixels. */
  viewport: Size;
  fullAccess: boolean;
  onDetails(): void;
  onClose(): void;
  /** How far the token's top stands above `anchor` as drawn, in the chrome's pixels (barDock.ts clearShift's `tokenHeight`). */
  tokenHeight: number;
  /** Moves the map down by this many of the chrome's pixels, or up when negative, for an upright phone's clearing move (barDock.ts clearShift). */
  onShift?(dy: number): void;
}) {
  const { token } = props;
  return (
    <BarFrame
      anchor={props.anchor}
      viewport={props.viewport}
      tokenHeight={props.tokenHeight}
      opening={token.id}
      onShift={props.onShift}
      label={`${displayName(token)} actions`}
      dock={{ text: displayName(token), show: `Show ${displayName(token)} actions`, closeLabel: "Close", close: props.onClose }}
    >
      <TokenBarBody token={token} fullAccess={props.fullAccess} onDetails={props.onDetails} onClose={props.onClose} />
    </BarFrame>
  );
}

/** The single token's bar inside its frame, which tells it whether it is short and whether it docks. */
function TokenBarBody(props: { token: ViewToken; fullAccess: boolean; onDetails(): void; onClose(): void }) {
  const { token } = props;
  const frame = useContext(FrameContext);
  const actions = useRoomActions();
  const ui = useRoomUi();
  const you = useRoomView((s) => s.you);
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const playersApplyDamage = useRoomView((s) => s.view?.meta.settings.playersApplyDamage ?? false);
  const scene = useRoomView((s) => s.view?.scenes[token.sceneId]);
  const tokens = useRoomView((s) => s.view?.tokens);
  const multi = useRoomView((s) => s.local.multi);
  const encounter = useRoomView((s) => s.view?.encounter);
  const monsters = useRoomView((s) => s.view?.monsters);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const scope = useRoomScope();
  const openRolls = useOpenRollOptions();
  const undoOffer = useStore(useScoped(lastMoveSlot), offered);
  const rest = frame.rest;
  const resting = rest?.resting === true;
  const scrolls = resting && rest.scrolls;
  const [entry, setEntry] = useState<EntryStatus>(QUIET_ENTRY);
  // The ids the quick row drew (RestRow's fit), null until it first fits.
  const [drawn, setDrawn] = useState<readonly string[] | null>(null);
  const drawers = useRestDrawers(rest, drawer, setDrawer);
  const multiToggle = useMultiToggle(rest, multi);
  const attachSlots = useAttachSlots(token);
  const detach = useDetach(token, attachSlots.includes("detach"));
  const detachNoteId = useId();

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
  const badge = elevationBadge(token.elevation);
  const target = { tokenId: token.id };
  // What an HP-less token stores underneath shows nowhere and takes no life control (docs/design-v1-combat-flow.md 3.6.6).
  const life = shownLife(actor, token) ?? "alive";
  const atZero = actor?.hp?.cur === 0 && (life === "dying" || life === "stable");
  const short = frame.short;
  const items = vitals({ actor, token, fullAccess: props.fullAccess || access.full, place: "bar" });
  const split = shortSplit(items);
  const block = useLinkedBlock(token, actor, access, character);
  // A creature companion's players read its block here too, as the DM does a monster's (docs/design-v1-companion-stat-blocks.md 6.6),
  // and a player character's DM and players its own stat block (docs/design-v1-pc-stats.md 7.4).
  const shown = statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor, companion: token.companion !== undefined, character: character !== undefined });
  const statBlock = (shown && character?.stats !== undefined) || opensStatBlock(shown, tokenStatBlock(actor, monsters, blocks));
  // A dead creature's bar offers the DM Revive after the Dead tag, and tells a player who may heal it what healing will do (docs/design-v1-combat-flow.md 3.5).
  // An HP-less token shows no life tag, so it has neither (docs/design-v1-token-panel.md 3.2).
  const noHp = hpLess(actor, token);
  const revives = useRoomView((s) => healRevivesDead(s.view?.meta.settings ?? {}));
  const deadLineId = useId();
  const revive = access.life && !noHp && offersRevive(life, token.kind);
  const deadLine = revive ? REVIVE_NOTE : life === "dead" && !noHp && !access.dm && access.hp !== "none" ? deadHealLine(displayName(token), revives) : null;

  const toggleEffect = (key: Effect["key"]) => {
    const existing = effects.find((e) => e.key === key);
    if (existing) actions.dispatch({ t: "actor.effect.remove", target, effectId: existing.id });
    else actions.dispatch({ t: "actor.effect.add", target, effect: { id: actions.newId(), key, ...(key === "exhaustion" ? { level: 1 } : {}) } });
  };

  const duplicate = useDuplicate(token, DUPLICATE_FOCUS_IN_BAR);

  const path = pathNow(encounter, token, you?.role ?? "player");
  const undoIds = barTokenIds(tokens, token);
  // Its combat uses (docs/design-v1-combat-controls.md 6), for the DM on any creature with one and for owners on theirs.
  const usesPresence = useUsesPresence(access.dm || access.owner ? target : null);
  const buttonInput = {
    dm: access.dm,
    owner: access.owner,
    undoMove: offersUndo(undoOffer, undoIds),
    movedThisTurn: path !== null && path.stops.length >= 2,
    // A player's own token: the door button finds the nearest door in reach itself, and shows nothing without one.
    door: true,
    light: (scene !== undefined && visionOn(scene)) || (token.light !== undefined && (token.light.bright > 0 || token.light.dim > 0)),
    companion: isCompanion(token),
    attach: attachSlots,
    uses: usesPresence,
  };
  const rows = barButtons(buttonInput);
  const lead = access.hp !== "none" && !noHp;
  // The strip's quick row: the HP entry's lead and its own candidates, then these (docs/design-v1-bar-compact.md 3.3).
  const restIds = rest ? restButtons({ ...buttonInput, lead }).filter((id) => id !== "mode") : [];
  const button = (id: BarButtonId): ReactNode => {
    switch (id) {
      case "undoMove":
        return <UndoMoveButton key={id} tokenIds={undoIds} />;
      case "countLeg":
        return <CountLegButton key={id} token={token} />;
      case "door":
        return <DoorButton key={id} token={token} />;
      case "conditions":
        return (
          <BarButton key={id} ref={drawers.ref("play", id)} pressed={drawer === "conditions"} onClick={() => drawers.toggle("conditions")}>
            Conditions
          </BarButton>
        );
      case "roll":
        return (
          <BarButton key={id} onClick={openRolls}>
            Roll
          </BarButton>
        );
      // Held while its block loads, then dropped if the block lists no use, so the buttons after it do not jump.
      case "uses":
        return (
          // Found among the play row's words by its icon (docs/design-v1-icons-2.md 8). The strip's own Uses keeps its words alone, since an icon there would push a control off it, and Conditions keeps its words in both, since its icon took the row a line on a 320 px phone at 130%.
          <BarButton key={id} ref={drawers.ref("play", id)} icon="uses" disabled={usesPresence === "loading"} pressed={drawer === "uses"} onClick={() => drawers.toggle("uses")}>
            Uses
          </BarButton>
        );
      // Toggles named for the state they are in, lit while it holds, so a lit button never reads as the opposite.
      case "hidden":
        return (
          <BarButton
            key={id}
            icon="hidden"
            iconOnly
            pressed={token.visibility === "dm"}
            onClick={() => {
              const showing = token.visibility === "dm";
              const change: ClientOp = { t: "token.update", tokenId: token.id, patch: { visibility: showing ? "all" : "dm" } };
              dispatchGesture(actions, showing ? [change, ...shownRowOps(encounter, [token.id])] : [change]);
            }}
          >
            Hidden
          </BarButton>
        );
      case "light":
        return <LightChip key={id} token={token} />;
      case "attach":
        return <AttachButton key={id} token={token} onOpen={frame.raise} />;
      case "detach":
        return <DetachButton key={id} token={token} detach={detach} noteId={detachNoteId} />;
      case "multiSelect":
        return (
          <BarButton key={id} ref={multiToggle.ref} pressed={multi} onClick={multiToggle.toggle}>
            Multi-select
          </BarButton>
        );
      case "locked":
        return (
          <BarButton key={id} icon="locked" iconOnly pressed={token.locked} onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { locked: !token.locked } })}>
            Locked
          </BarButton>
        );
      case "duplicate":
        return (
          <BarButton key={id} icon="duplicate" iconOnly onClick={duplicate}>
            Duplicate
          </BarButton>
        );
      case "delete":
        return (
          <DeleteButton
            key={id}
            holdsRoom
            onDelete={() => {
              actions.dispatch({ t: "token.delete", tokenId: token.id });
              props.onClose();
            }}
          />
        );
      // A companion's owners who are not the DM dismiss it in Delete's place (docs/design-v1-combat-flow.md 3.6.9).
      case "dismiss":
        return <DismissButton key={id} tokenId={token.id} name={displayName(token)} />;
    }
  };

  // The strip's own buttons. Conditions and Uses expand the bar with their drawer open, and Undo move draws as the undo arrow (3.3, 5.3, R13).
  const restButton = (id: string): ReactNode => {
    switch (id) {
      case "undoMove":
        return <UndoMoveButton tokenIds={undoIds} arrow />;
      case "conditions":
      case "uses":
        return (
          <BarButton ref={drawers.ref("rest", id)} disabled={id === "uses" && usesPresence === "loading"} pressed={drawer === id} onClick={() => drawers.fromRest(id)}>
            {id === "uses" ? "Uses" : "Conditions"}
          </BarButton>
        );
      case "details":
        return <BarButton onClick={props.onDetails}>Details</BarButton>;
      default:
        return button(id as BarButtonId);
    }
  };
  const restItems: RestItem[] = restIds.map((id) => ({ id, node: restButton(id) }));
  // What the quick row drew is out of the scrolling strip's rows below it. Before its first fit, every candidate counts as drawn.
  const inStrip = (id: string) => scrolls && (drawn ?? restIds).includes(id);
  const status = useRestStatus({ entry: lead ? entry : QUIET_ENTRY, idle: vitalsWords(split.line), critInRow: drawn === null || drawn.includes("crit"), active: resting });

  const savesAndDefenses = short ? (
    <MoreStats more={split.more} block={block} />
  ) : (
    <>
      <SavesLine block={block} />
      <DefenseLines block={block} clamp />
    </>
  );

  const badgeText = badge ? <span style={{ flex: "none", color: theme.color.accentSoft, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>{badge} ft</span> : null;
  // A window too narrow for the badge in its header's one row shows it under the name instead (docs/design-v1-token-window.md 7.1).
  const badgeInHeader = frame.header.badgeInHeader;
  const reviveButton = revive ? <ReviveButton target={target} describedBy={deadLineId} focusTo={REVIVE_FOCUS_IN_BAR} /> : undefined;
  const deadNote = deadLine ? (
    <div id={deadLineId} style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
      {deadLine}
    </div>
  ) : null;

  return (
    <>
      <BarHeader
        // Two lines of the name at most: the frame's name holds all of it, and the token's plate shows it on the map.
        title={displayName(token)}
        status={resting ? status.node : undefined}
        sentence={resting ? status.status.sentence : null}
        actions={badgeInHeader ? badgeText : null}
        onClose={props.onClose}
      />
      {resting ? status.probe : null}
      {/* The strip's status line holds the vitals while it rests. The entry after them keeps its place either way, so its field carries over (5.3). */}
      {resting ? null : <VitalsLine items={short ? split.line : items} afterTag={reviveButton} end={badgeInHeader ? undefined : badgeText} />}
      {resting ? null : deadNote}

      {access.hp !== "none" && !noHp ? (
        <HpEntry
          targets={[oneTarget(target, access.hp, atZero, { name: displayName(token), dead: life === "dead", max: actor?.hp?.max })]}
          access={access.hp}
          place="bar"
          fieldFirst={short}
          rest={rest ? { resting, scrolls, items: restItems, shown: drawn, onFit: setDrawn, onStatus: setEntry } : undefined}
        />
      ) : resting ? (
        <RestRow items={restItems} onFit={setDrawn} />
      ) : null}

      {/* The scrolling strip holds the rest of the bar under its quick row, in the expanded bar's order (5.4). */}
      {resting && !scrolls ? null : (
        <>
          {scrolls && (reviveButton || deadNote) ? (
            <div style={{ display: "grid", gap: theme.space(1) }}>
              {reviveButton}
              {deadNote}
            </div>
          ) : null}
          {life === "dying" && access.deathSaves && actor?.deathSaves ? (
            <DeathSaves
              saves={actor.deathSaves}
              canEdit
              target={target}
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
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <EffectIcon effect={effect} size={20} />
                  {effectChip(effect).label}
                  {effect.hiddenFromPlayers ? <span style={{ color: theme.color.textMuted }}>(hidden)</span> : null}
                </li>
              ))}
            </ul>
          ) : null}

          {savesAndDefenses}

          {/* What it rides or carries, each a tap away, so a phone reaches a rider that hides its mount (docs/design-v1-attach.md 4.4). */}
          <GroupLine token={token} />

          {/*
            Stat block and Details both open the panel, so they sit with the summary they expand. The DM's View as a player
            looks too, so it joins them, and on an upright phone's resting strip it waits in the expanded bar with the DM's
            other buttons that the strip leaves out (D-261027-09).
          */}
          <div role="group" aria-label="Read more" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
            {statBlock ? <BarButton onClick={() => openStatBlock(scope, ui, token.id)}>Stat block</BarButton> : null}
            {inStrip("details") ? null : <BarButton onClick={props.onDetails}>Details</BarButton>}
            <ViewAsButton token={token} />
          </div>

          {access.canEditToken("elevation") ? (
            <StepperRow label="Elevation">
              <BarButton label="Down 5 feet" onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { elevation: (token.elevation ?? 0) - 5 } })}>
                −5
              </BarButton>
              <span style={{ minWidth: 56, textAlign: "center", fontWeight: theme.weight.bold }}>{token.elevation ?? 0} ft</span>
              <BarButton label="Up 5 feet" onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { elevation: (token.elevation ?? 0) + 5 } })}>
                +5
              </BarButton>
            </StepperRow>
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
          {drawer === "uses" && rows.play.includes("uses") ? <UsesDrawer target={target} name={displayName(token)} onClose={drawers.close} /> : null}

          {rows.passing.some((id) => !inStrip(id)) ? (
            <ButtonRow row="passing">{rows.passing.filter((id) => !inStrip(id)).map(button)}</ButtonRow>
          ) : null}
          <ButtonRow row="play">{rows.play.filter((id) => !inStrip(id)).map(button)}</ButtonRow>
          {rows.play.includes("detach") ? <DetachNote detach={detach} id={detachNoteId} /> : null}
          {/* Used a few times a campaign, so after the steady line, which it would push out of view on an upright phone, and before the less-used buttons (docs/design-v1-token-window.md 8.9). */}
          {access.dm || (access.owner && !token.locked) ? <SizeRow token={token} owner={access.owner} canResize={access.resize} /> : null}
          {rows.less.length > 0 ? (
            <ButtonRow row="less">{rows.less.map(button)}</ButtonRow>
          ) : null}
        </>
      )}
    </>
  );
}

/**
 * The bar for several selected tokens (features sections 5 and 10, and
 * docs/design-v1-dm-tools.md 3.5): who is in the group, one HP entry for
 * all of them, dragging any of them moves the group (lib/group.ts), and the
 * edits that make sense for a group: conditions and elevation, and for the
 * DM Hidden, Roll, Locked, Add to the fight, Delete and More. An action shows only
 * when the viewer may apply it to every selected token, so nothing here is
 * refused. Each tap is one undo step.
 */
export function GroupActionBar(props: {
  tokens: readonly ViewToken[];
  /** How many of them this member may move: a drag moves only those. */
  movable: number;
  anchor: Point;
  viewport: Size;
  tokenHeight: number;
  onClose(): void;
  onShift?(dy: number): void;
}) {
  const { tokens } = props;
  return (
    <BarFrame
      anchor={props.anchor}
      viewport={props.viewport}
      tokenHeight={props.tokenHeight}
      // One opening while the group grows and shrinks, which keeps this bar mounted.
      opening="group"
      onShift={props.onShift}
      label={`${tokens.length} selected tokens`}
      dock={{ text: `${tokens.length} selected`, show: `Show actions for ${tokens.length} selected tokens`, closeLabel: "Deselect all", close: props.onClose }}
    >
      <GroupBarBody tokens={tokens} movable={props.movable} onClose={props.onClose} />
    </BarFrame>
  );
}

/** The group's bar inside its frame, which tells it whether it rests as an upright phone's strip. */
function GroupBarBody(props: { tokens: readonly ViewToken[]; movable: number; onClose(): void }) {
  const { tokens } = props;
  const frame = useContext(FrameContext);
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
  // The rows join by the rule every path into a fight shares (combat/state.ts useFightJoin), reading their blocks for the DM only.
  const joining = useMemo(() => (offers.dm ? fightCandidates(tokens, encounter) : []), [offers.dm, tokens, encounter]);
  const join = useFightJoin(joining);
  const joinState = join.stateOf(joining);
  const outOfFight = fightCandidates(tokens, encounter).length;
  const scope = useRoomScope();
  const anyPlayed = useRoomView((s) => (s.view ? offersRequest(s.view, tokens) : false));
  const openRolls = useOpenRollOptions();
  const undoOffer = useStore(useScoped(lastMoveSlot), offered);
  const rest = frame.rest;
  const resting = rest?.resting === true;
  const scrolls = resting && rest.scrolls;
  const drawers = useRestDrawers(rest, drawer, setDrawer);
  const multiToggle = useMultiToggle(rest, multi);
  const [entry, setEntry] = useState<EntryStatus>(QUIET_ENTRY);
  // The ids the quick row drew (RestRow's fit), null until it first fits.
  const [drawn, setDrawn] = useState<readonly string[] | null>(null);
  const lead = useGroupHp(tokens).access !== "none";
  // The group's strip (docs/design-v1-bar-compact.md 9.4): its entry as the lead, then these.
  const restIds = rest ? groupRestButtons({ dm: offers.dm, lead, conditions: offers.conditions, undoMove: offersUndo(undoOffer, ids) }).filter((id) => id !== "mode") : [];
  const inStrip = (id: string) => scrolls && (drawn ?? restIds).includes(id);
  const names = tokens.map((t) => displayName(t)).join(", ");
  // With nothing else to say, the status line names who is selected, as the line under the expanded bar's header does.
  const status = useRestStatus({ entry, idle: [names], critInRow: drawn === null || drawn.includes("crit"), active: resting });

  const hiddenButton = (
    <BarButton
      pressed={hidden === "all"}
      half={hidden === "some"}
      icon="hidden"
      iconOnly
      onClick={() => {
        const patch = flagPatch(tokens, "hidden");
        send([...updateManyOps(ids, patch), ...(patch.visibility === "all" ? shownRowOps(encounter, ids) : [])]);
      }}
    >
      Hidden
    </BarButton>
  );
  const multiButton = (
    <BarButton ref={multiToggle.ref} pressed={multi} onClick={multiToggle.toggle}>
      Multi-select
    </BarButton>
  );
  const rollButton = <BarButton onClick={openRolls}>Roll</BarButton>;
  const restItems: RestItem[] = restIds.map((id) => ({
    id,
    node:
      id === "conditions" ? (
        <BarButton ref={drawers.ref("rest", id)} pressed={drawer === "conditions"} onClick={() => drawers.fromRest("conditions")}>
          Conditions
        </BarButton>
      ) : id === "undoMove" ? (
        <UndoMoveButton tokenIds={ids} arrow />
      ) : id === "roll" ? (
        rollButton
      ) : id === "hidden" ? (
        hiddenButton
      ) : (
        multiButton
      ),
  }));

  return (
    <>
      <BarHeader title={`${tokens.length} selected`} status={resting ? status.node : undefined} sentence={resting ? status.status.sentence : null} onClose={props.onClose} closeLabel="Deselect all" />
      {resting ? status.probe : null}
      {/* The names stand in the strip's status line while it rests, so they are hidden there, and the entry after them keeps its place. */}
      <div hidden={resting} style={{ color: theme.color.textMuted, overflowWrap: "anywhere" }}>
        {names}
      </div>
      {lead ? <GroupBarHp tokens={tokens} rest={rest ? { resting, scrolls, items: restItems, shown: drawn, onFit: setDrawn, onStatus: setEntry } : undefined} /> : resting ? (
        <>
          <GroupBarHp tokens={tokens} rest={{ resting, scrolls, items: restItems, shown: drawn, onFit: setDrawn, onStatus: setEntry }} />
          <RestRow items={restItems} onFit={setDrawn} />
        </>
      ) : (
        <GroupBarHp tokens={tokens} />
      )}
      {resting && !scrolls ? null : (
        <>
          {props.movable >= 2 ? (
            <div style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
              {props.movable === tokens.length ? "Drag any of them to move them all." : `A drag moves the ${props.movable} of them you may move.`}
            </div>
          ) : null}
          {offers.elevation ? (
            <StepperRow label="Elevation">
              <BarButton label="All down 5 feet" onClick={() => send(elevationOps(tokens, -5))}>
                −5
              </BarButton>
              <span style={{ minWidth: 56, textAlign: "center", fontWeight: theme.weight.bold }}>{elevation === null ? "Mixed" : `${elevation} ft`}</span>
              <BarButton label="All up 5 feet" onClick={() => send(elevationOps(tokens, 5))}>
                +5
              </BarButton>
            </StepperRow>
          ) : null}
          {drawer === "conditions" && offers.conditions ? (
            <QuickConditions lit={(key) => conditionLit(creatures, key)} onToggle={(key) => send(conditionOps(creatures, key, actions.newId))} />
          ) : null}
          {/* Undo move on a line of its own while it shows, so the steady line below never moves (docs/design-v1-token-window.md 3.2). */}
          <ButtonRow row="passing">{inStrip("undoMove") ? null : <UndoMoveButton tokenIds={ids} />}</ButtonRow>
          <ButtonRow row="play">
            {offers.conditions && !inStrip("conditions") ? (
              <BarButton ref={drawers.ref("play", "conditions")} pressed={drawer === "conditions"} onClick={() => drawers.toggle("conditions")}>
                Conditions
              </BarButton>
            ) : null}
            {offers.dm && !inStrip("hidden") ? hiddenButton : null}
            {inStrip("multiSelect") ? null : multiButton}
            {offers.dm && !inStrip("roll") ? rollButton : null}
            {offers.dm && anyPlayed ? <BarButton onClick={() => openAsk(scope, { kind: "selection", tokenIds: ids })}>Request a roll</BarButton> : null}
            {offers.dm ? (
              <BarButton pressed={locked === "all"} half={locked === "some"} icon="locked" iconOnly onClick={() => send(updateManyOps(ids, flagPatch(tokens, "locked")))}>
                Locked
              </BarButton>
            ) : null}
            {offers.dm && outOfFight > 0 ? (
              <BarButton busy={joinState === "loading"} disabled={joinState === "failed"} onClick={() => send(fightOps(tokens, encounter, actions.newId, join.mark))}>
                {encounter ? "Add to the fight" : "Start a fight"}
              </BarButton>
            ) : null}
            {offers.dm ? (
              <BarButton ref={moreButton} icon="more" iconOnly always onClick={() => setMore(true)}>
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
            <BarButton icon="close" iconOnly always onClick={props.onClose}>
              Clear
            </BarButton>
          </ButtonRow>
          {offers.dm && outOfFight > 0 && joinState === "failed" ? <SrdLoadFailed what="The stat blocks" inline /> : null}
        </>
      )}
      {more ? <GroupMoreSheet tokens={tokens} opener={moreButton} onClose={() => setMore(false)} /> : null}
    </>
  );
}

/**
 * A bar's Roll (docs/design-v1-roll-options.md 4.1): the Dice panel, asked
 * to scroll to the roll options. A bar shows only for a selection, so the
 * options already name its tokens. A player's earlier pick of another of
 * their creatures gives way, so the options are this token's.
 */
/**
 * A bar's Roll: the Dice panel's options for the token or group (4.1). A
 * group save shown in the panel steps back to the first page, where its
 * row still opens it, so the Roll never lands on another page.
 */
function useOpenRollOptions(): () => void {
  const ui = useRoomUi();
  const options = useOptionStore();
  const groupSave = useGroupSaveStore();
  return () => {
    options.setState((s) => ({ focus: s.focus + 1, picked: null }));
    if (groupSave.getState().shownIn === "dice") groupSave.setState({ shownIn: null });
    ui.openPanel("dice");
  };
}

/** The group's HP entry, field and Apply first while the window is short, as the frame decides (5.8), and the strip's lead on an upright phone. */
function GroupBarHp(props: { tokens: readonly ViewToken[]; rest?: HpRest }) {
  const frame = useContext(FrameContext);
  return <GroupHpEntry tokens={props.tokens} place="bar" fieldFirst={frame.short} rest={props.rest} />;
}

/**
 * A player's way to take back the moves they just made with a finger
 * (features 13), newest first, shown while the move is the newest change of
 * theirs this device knows of (undoMove.ts). The server answers with what
 * it undid, or that the move is no longer the newest step when another
 * device changed the stack meanwhile.
 */
function UndoMoveButton(props: { tokenIds: readonly string[]; arrow?: boolean }) {
  const actions = useRoomActions();
  const offer = useStore(useScoped(lastMoveSlot), offered);
  if (!offer || !offersUndo(offer, props.tokenIds)) return null;
  // The button goes with the move it took back, Roll taking the strip's place, so focus moves to the bar's frame, as Revive's does (D-261024-42).
  const undo = () => {
    const pressed = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (actions.dispatch(undoOf(offer)) !== null) handFocusOn(pressed?.closest<HTMLElement>(BAR_FRAME), [":scope"]);
  };
  // The strip's is the undo arrow alone, named and tipped "Undo move" as the top bar's Undo is, so it fits Roll's place (docs/design-v1-bar-compact.md R13).
  return props.arrow ? (
    <BarButton icon="undo" iconOnly always onClick={undo}>
      Undo move
    </BarButton>
  ) : (
    <BarButton onClick={undo}>Undo move</BarButton>
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
  const before = path && path.stops.length >= 2 ? path.stops[path.stops.length - 2] : undefined;
  // A resize's leg, or a squeeze's in place, is no move, so it has nothing to stop counting (docs/design-v1-token-window.md 8.7).
  if (!last || !before || reshapeLeg(before, last, stopFootprint(props.token))) return null;
  const off = last.uncounted === true;
  const press = () => {
    // The bar's undo waits for the server, and a second press meanwhile would act on a mark about to change.
    if (undoing) return;
    if (offer && offersMarkUndo(offer, props.token.id)) actions.dispatch(undoOf(offer));
    else actions.dispatch({ t: "token.countLeg", tokenId: props.token.id, counts: off });
  };
  return (
    <BarButton pressed={off} label="The last move doesn't count against Speed, for a shove or a teleport" onClick={press}>
      Doesn't count
    </BarButton>
  );
}

/**
 * What a bar's frame hands its header and its rows: the header's handle,
 * with its grip, and stickiness, Reset while the window docks away from
 * its default (docs/design-v1-token-window.md 4.4), an upright phone's
 * resting strip and its Expand and Collapse (docs/design-v1-bar-compact.md
 * 9.2), the narrow header's grip and badge (7.1), and whether the bar is
 * short.
 */
type FrameControls = {
  handle: PaneHandle | null;
  sticky: boolean;
  place: { moved: boolean; reset(): void; closeRef: RefObject<HTMLButtonElement | null>; onResetFocus(focused: boolean): void } | null;
  /**
   * The bar spans an upright phone: it rests as the strip or is expanded,
   * and the button left of Close switches. `scrolls` is the strip where
   * Expand is not offered, which holds the whole bar under its quick row
   * and scrolls (5.4). `words` is a strip wide enough for Expand's and
   * Collapse's words beside the chevron. Null where the bar docks or opens
   * compact.
   */
  rest: { resting: boolean; scrolls: boolean; expand(): void; collapse(): void; words: boolean } | null;
  /** The grip a button or its dots, and where an elevation badge goes, by the docked window's width (barDock.ts headerLayout). */
  header: { grip: "button" | "dots"; badgeInHeader: boolean };
  /** The bar has under 300 px where it stands (barButtons.ts barShort), whatever its content. */
  short: boolean;
  /** Stands the bar over the notices while a popover of its own is open (docs/design-v1-tool-options.md 7.6). */
  raise(on: boolean): void;
  /** The strip's own controls for its header, while the bar spans an upright phone. */
  strip: StripControls | null;
};

/**
 * What the strip's header needs of its frame (docs/design-v1-bar-compact.md
 * 3.5 and 5.4): Scroll for more and the way back to the top in the
 * scrolling strip, and the alerts' summary row while it stands in the
 * header for want of a spot over the band.
 */
type StripControls = { scrollMore(): void; toTop(): void; summary: HeaderSummary | null };

/** The header wherever the window does not dock, or docks at its full width. */
const WHOLE_HEADER: FrameControls["header"] = { grip: "button", badgeInHeader: true };

const NO_RAISE = () => {};

const FrameContext = createContext<FrameControls>({ handle: null, sticky: false, place: null, rest: null, header: WHOLE_HEADER, short: false, raise: NO_RAISE, strip: null });

/**
 * The strip's width, in layout px, from which Expand and Collapse show
 * their words beside the chevron (docs/design-v1-icons-2.md 8): 374, the
 * strip of a 390 x 844 phone at 100%, and the 57 the words add to the
 * button. From there the title keeps the 252 px it has on that phone with
 * the chevron alone, the room the bar design fits the HP entry's sentences
 * to, so the words never send a sentence such as "7 damage, not Goblin 1,
 * Goblin 2" from its line to the title's two lines. That leaves the words
 * to a phone at 85%, such as 390 x 844 (443 px).
 */
const EXPAND_WORDS_MIN = 431;

/** Reset's name and tooltip, on every device. */
const RESET_LABEL = "Reset window position and size";

/**
 * A sentence of the HP entry's that the strip shows over its title or in
 * its note (docs/design-v1-bar-compact.md 3.3): the content measures it,
 * decides where it goes, and cuts it for the note.
 */
type RestSentence = { text: string; error: boolean; place: "title" | "note" };

/**
 * The bar's header: the grip while it docks, its name on at most two
 * lines, the elevation badge, Reset while the window is away from its
 * default, Expand or Collapse while it spans an upright phone, and Close.
 * Sticky while it docks or is expanded.
 *
 * While the strip rests (docs/design-v1-bar-compact.md 3.3) the name takes
 * one line and `status`, which the content passes, the line under it. A
 * `sentence` placed "title" takes both lines in their place, and one
 * placed "note" stands on the strip's top edge, its words the field's
 * description already, so the note itself is hidden from screen readers.
 * Where Expand is not offered the header scrolls with the strip, and
 * Scroll for more takes Expand's place (5.4). The alerts' summary row,
 * where no spot is left for it over the band, stands left of that button
 * (3.5).
 */
function BarHeader(props: { title: string; status?: ReactNode; sentence?: RestSentence | null; actions?: ReactNode; onClose(): void; closeLabel?: string }) {
  const frame = useContext(FrameContext);
  const { place, rest, strip } = frame;
  const resting = rest?.resting === true;
  // An error or a refusal brings the scrolling strip's header and quick row back into view as it comes, and leaves the strip to the viewer after (5.4, review BB-OPUS-1).
  const error = resting && props.sentence?.error === true ? props.sentence.text : null;
  const errorWas = useRef<string | null>(null);
  useLayoutEffect(() => {
    const came = error !== null && error !== errorWas.current;
    errorWas.current = error;
    if (came && rest?.scrolls) strip?.toTop();
  }, [error, rest?.scrolls, strip]);
  const summary = resting && strip?.summary ? <HeaderSummaryButton summary={strip.summary} /> : null;
  const sizeName = rest?.resting ? "Expand" : "Collapse";
  // The name on hover, keyboard focus and a long press, while the chevron stands alone.
  const sizeTip = useTooltip(sizeName);
  const nameRef = useRef<HTMLSpanElement>(null);
  const wordsRef = useRef<HTMLSpanElement>(null);
  // Whether this token's name fits whole beside Expand's words, read on the strip for each name. Unread, as for a name that changed while expanded, the chevron stands alone.
  const [nameFit, setNameFit] = useState<{ title: string; fits: boolean } | null>(null);
  const nameFits = nameFit !== null && nameFit.title === props.title && nameFit.fits;
  // Expand and Collapse change the whole bar, so they say so in words beside the chevron where the strip is wide enough, the name still fits whole and no summary stands beside them, else the chevron alone names itself (D-261024-37 amended, D-261024-46).
  const restWords = rest !== null && rest.words && nameFits && summary === null;
  useLayoutEffect(() => {
    const name = nameRef.current;
    const words = wordsRef.current;
    const button = words?.parentElement;
    if (!name || !words || !button || !rest?.words) return;
    // Text widths by ranges, which an ellipsis or a clip leaves whole, all in the screen's px.
    const textWidth = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().width;
    };
    const zoom = button.offsetWidth > 0 ? button.getBoundingClientRect().width / button.offsetWidth : 1;
    const nameWidth = textWidth(name);
    const room = name.getBoundingClientRect().width;
    /*
     * Shown, the words keep their place while the name is whole. Hidden,
     * they come back only where the name keeps a pixel to spare beside the
     * room they would take: their width, the small chevron, the gap, the
     * button's padding and border, less what the chevron alone draws. The
     * pixel apart is what keeps a name right at the edge from flipping the
     * look on every render.
     */
    const fits = restWords
      ? nameWidth <= room + 0.5
      : nameWidth <= room - (textWidth(words) + (theme.icon.sm + theme.space(2) + 2 * theme.space(3) + 2 * theme.line.border) * zoom - button.getBoundingClientRect().width) - zoom;
    if (nameFit === null || nameFit.title !== props.title || nameFit.fits !== fits) setNameFit({ title: props.title, fits });
  });
  const sizeButton = !rest ? null : rest.scrolls ? (
    <IconButton icon="scrollMore" label="Scroll for more" onClick={() => strip?.scrollMore()} />
  ) : (
    // One button in both looks, its words hidden from sight but kept as its name while the chevron stands alone, so focus stays on it as they come and go (D-261024-46).
    <>
      <Button
        size="sm"
        variant="quiet"
        data-bar-size=""
        {...(restWords ? null : sizeTip.anchor())}
        onClick={rest.resting ? rest.expand : rest.collapse}
        style={restWords ? { flex: "none", position: "relative" } : { flex: "none", position: "relative", padding: 0, color: theme.color.textMuted }}
      >
        <Icon name={rest.resting ? "chevronUp" : "chevronDown"} size={restWords ? "sm" : "md"} />
        <span ref={wordsRef} style={restWords ? undefined : VISUALLY_HIDDEN}>
          {sizeName}
        </span>
      </Button>
      {restWords ? null : sizeTip.tip}
    </>
  );
  // Reset shows only while the window docks, and the size only while the bar spans, so the two never stand together.
  const beforeClose = place?.moved ? (
    <IconButton icon="windowHome" label={RESET_LABEL} onClick={place.reset} onFocus={() => place.onResetFocus(true)} onBlur={() => place.onResetFocus(false)} />
  ) : sizeButton ? (
    <>
      {summary}
      {sizeButton}
    </>
  ) : null;
  const handle = frame.handle && frame.header.grip === "dots" ? { ...frame.handle, grip: { ...frame.handle.grip, dots: true } } : frame.handle;
  const sentence = resting ? (props.sentence ?? null) : null;
  const status = resting && props.status !== undefined ? props.status : null;
  const title =
    sentence?.place === "title" ? (
      <span style={{ ...SENTENCE_LINES, fontSize: theme.font.small, fontWeight: theme.weight.regular, color: sentence.error ? theme.color.dangerText : theme.color.text }}>{sentence.text}</span>
    ) : status !== null ? (
      <>
        <span ref={nameRef} style={RESTING_LINE}>
          {props.title}
        </span>
        <span style={{ ...RESTING_LINE, color: theme.color.textMuted, fontSize: theme.font.small, fontWeight: theme.weight.regular }}>{status}</span>
      </>
    ) : (
      props.title
    );
  return (
    <>
      <PaneHeader
        title={title}
        actions={props.actions}
        beforeClose={beforeClose}
        onClose={props.onClose}
        closeLabel={props.closeLabel}
        closeRef={place?.closeRef}
        handle={handle ?? undefined}
        sticky={frame.sticky}
        lines={status === null && sentence?.place !== "title" ? 2 : undefined}
      />
      {sentence?.place === "note" ? (
        <div aria-hidden data-rest-note="" style={{ ...NOTE_BOX, color: sentence.error ? theme.color.dangerText : theme.color.text }}>
          <span style={SENTENCE_LINES}>{sentence.text}</span>
        </div>
      ) : null}
    </>
  );
}

/** A line of the resting header's title, cut with an ellipsis. */
const RESTING_LINE: CSSProperties = { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/** A sentence over the title's two lines, or the note's: never more than two, on the status line's 18 px lines. */
const SENTENCE_LINES: CSSProperties = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "normal", lineHeight: "18px", overflowWrap: "anywhere" };

/**
 * The strip's note (3.3): on its top edge across the frame, its words
 * barDock.ts NOTE_INSET in from each side and 8 px from its top and foot, so two
 * lines take the 52 px the band and the gap hold above the strip. Its
 * containing block is the frame, so the scroller never clips it.
 */
const NOTE_BOX: CSSProperties = {
  position: "absolute",
  left: -theme.line.border,
  right: -theme.line.border,
  bottom: "100%",
  boxSizing: "border-box",
  padding: `${theme.space(2)}px ${NOTE_INSET}px`,
  background: theme.color.surface,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  borderRadius: theme.radius.lg,
  boxShadow: theme.shadow.pane,
  fontSize: theme.font.small,
  pointerEvents: "none",
};

/** The alerts' summary row standing in the strip's header (3.5): its count, named and tipped by its words, with the row's own tap. */
function HeaderSummaryButton(props: { summary: HeaderSummary }) {
  const tip = useTooltip(props.summary.name);
  return (
    <>
      <button
        type="button"
        data-rest-summary=""
        aria-label={props.summary.name}
        onClick={props.summary.press}
        {...tip.anchor()}
        style={{
          flex: "none",
          width: theme.touch,
          height: theme.touch,
          borderRadius: theme.radius.md,
          border: `${theme.line.border}px solid ${theme.color.warning}`,
          background: theme.color.warningFill,
          color: theme.color.text,
          fontFamily: theme.font.body,
          fontSize: theme.font.body14,
          fontWeight: theme.weight.bold,
          cursor: "pointer",
        }}
      >
        {props.summary.count}
      </button>
      {tip.tip}
    </>
  );
}

/** How long the window's keys rest before its status speaks. */
const KEYS_REST_MS = 500;

/**
 * A drag in progress: a move of the window by its header or grip, or a
 * resize by its handle or a band, with the pointer, where it went down,
 * the box the window had then and has now, and the limits a resize meets.
 */
type Drag = { kind: "move" | ResizePart; pointerId: number; el: HTMLElement; x: number; y: number; start: Box; box: Box | null; limits: ResizeLimits };

/**
 * Where a bar sits (docs/design-v1-bar-dock.md). From 600 layout px up, and
 * on a phone on its side, it docks in the map's free area as the token
 * window, at the bottom right unless the viewer moved it there by its
 * header, its grip or the grip's arrow keys, and this device remembers
 * the spot (`rvtt.tokenBarSpot`, barDock.ts). Reset in its header brings
 * it home (docs/design-v1-token-window.md 4). A
 * phone held upright rests it as a strip at the foot of the map's free
 * area, 114 px tall, which never follows its token, and Expand grows it up
 * from the same foot (docs/design-v1-bar-compact.md). Where Expand would
 * add less than a header, the strip scrolls to the rest of the bar instead.
 * A screen too short for either opens it compact: a taller overlay over
 * the Multi-select bar, and over the toolbar when even that is short,
 * which scrolls as a whole and does not move. In each, a bar that meets
 * the fight alerts column across shares the right lane with it
 * (barDock.ts shareLane), and once it is drawn it publishes its box for
 * the column, the notices and the camera.
 *
 * It scrolls inside when its content outgrows its room, with a "Scroll
 * for more" fade at the bottom while anything is hidden, so Duplicate or
 * Delete never sit out of view without a hint. While it docks or is
 * expanded its header sticks to the top, so the handle and Close never
 * scroll away. The resting strip draws no fade, and its scrolling form's
 * header scrolls with it, Scroll for more in Expand's place.
 *
 * The strip clears its own token once, by moving the map, as the viewer
 * opens it or shows another token in it, and as it comes back after a
 * drop: it consumes the dock store's `clearRequest`, which Stage sets for
 * those alone (3.6). Expand clears the expanded bar's token the same way.
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
  viewport: Size;
  /** How far the token's top stands above `anchor` as drawn (barDock.ts clearShift's `tokenHeight`). */
  tokenHeight: number;
  /** What the bar opened for: the token's id, or "group". */
  opening: string;
  onShift?(dy: number): void;
  label: string;
  dock: { text: string; show: string; closeLabel: string; close(): void };
  children: ReactNode;
}) {
  const layout = useLayoutSize();
  const zoom = useUiScale();
  const anySheet = useRoomView((s) => sheetOpen(s.local));
  const full = useStore(useScoped(dockSlot), (s) => s.sheetFull);
  // "View as a player" reads this device's spot and size and keeps its own changes to itself, since nothing done there is saved.
  const preview = usePreview() !== null;
  const dockStore = useScoped(barDockSlot);
  const measured = useStore(dockStore, (s) => s.chrome);
  const lasting = useStore(dockStore, (s) => s.lasting);
  const chrome = useMemo(() => barChrome({ chrome: measured, lasting }), [measured, lasting]);
  // While someone types with the on-screen keyboard up, the bar is placed over it (barDock.ts Typing).
  const typing = useStore(dockStore, (s) => s.typing);
  // Beside a sideways sheet that leaves it too little room for its header, the window folds into the sheet's header (docs/design-v1-token-window.md 7.1).
  const folded = foldsUnderSheet({ ...layout, sheetOpen: anySheet, full, sideRoom: sideSheetRoom(props.viewport, chrome) });
  const spot = useStore(dockStore, (s) => s.spot);
  const size = useStore(dockStore, (s) => s.size);
  const finePointer = useStore(dockStore, (s) => s.finePointer);
  const width = useStore(dockStore, (s) => s.defaultWidth);
  const column = useStore(dockStore, (s) => s.column);
  const foot = useStore(dockStore, (s) => s.foot);
  const heldMode = useStore(dockStore, (s) => s.heldMode);
  const cardAt = useStore(dockStore, (s) => s.cardAt);
  const expanded = useStore(dockStore, (s) => s.expanded);
  const expandedHeight = useStore(dockStore, (s) => s.expandedHeight);
  const clearRequest = useStore(dockStore, (s) => s.clearRequest);
  const headerSummary = useStore(dockStore, (s) => s.headerSummary);
  /*
   * An upright phone's strip (docs/design-v1-bar-compact.md 2 and 3): its
   * mode as held or as the opening rule gives it, the foot it stands on (a
   * roll card that would take the free area under 148 folds into the
   * alerts instead, stripSqueezed), whether Expand is offered there, and
   * whether it rests, is expanded or scrolls where Expand is not offered.
   * A bar expanded when Expand stops being offered keeps `expanded` and
   * scrolls until it is offered again.
   */
  const spans = heldOrOpenMode({ layout, free: freeArea(props.viewport, chrome, foot), foot, cardAt, heldMode }) === "span";
  const restFoot = spans && stripSqueezed({ viewport: props.viewport, chrome, foot, held: true }) ? 0 : foot;
  const stripFree = freeArea(props.viewport, chrome, restFoot);
  const offered = spans && expandOffered({ layout, free: stripFree });
  const restState: RestState = spans && expanded && offered ? "expanded" : "rest";
  const scrolls = spans && !offered;
  const barRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [barHeight, setBarHeight] = useState(() => dockStore.getState().lastHeight);
  // The content has been measured, not taken from the last bar's height.
  const [contentMeasured, setContentMeasured] = useState(false);
  const [clipped, setClipped] = useState(false);
  const [pad, setPad] = useState({ top: 0, bottom: 0 });
  const [status, setStatus] = useState("");
  const statusSeq = useRef(0);
  const handleDescription = useId();
  // The handle is an icon alone on a computer, so it names itself in the shared tooltip, on hover and on keyboard focus (docs/design-v1-icons.md 3.2).
  const handleTip = useTooltip("Resize window");
  /*
   * What the window's status says after its keys or Reset. It is cleared,
   * then set on the next frame, so the same words twice are spoken again
   * rather than heard as no change. A drop clears it, so it never names a
   * place the window has left.
   */
  const say = (text: string) => {
    const id = ++statusSeq.current;
    setStatus("");
    if (!text) return;
    requestAnimationFrame(() => {
      if (statusSeq.current === id) setStatus(text);
    });
  };
  // Spoken once the keys rest, so a held key is heard once, from where they left the window.
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sayAtRest = (words: () => string) => {
    if (restTimer.current !== null) clearTimeout(restTimer.current);
    restTimer.current = setTimeout(() => {
      restTimer.current = null;
      say(words());
    }, KEYS_REST_MS);
  };
  useEffect(
    () => () => {
      if (restTimer.current !== null) clearTimeout(restTimer.current);
    },
    [],
  );
  const [dragBox, setDragBox] = useState<Box | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [raised, setRaised] = useState(false);
  useSheetReturnFocus(barRef, RETURN_RANK.tokenBar);
  usePublishBar({ label: props.label, ...props.dock, frame: barRef });
  /*
   * The content's whole height, whether anything is cut off below, and the
   * scroll padding that keeps a control scrolled into view clear of the
   * sticky header above and the "Scroll for more" fade below (5.7).
   */
  const measure = () => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    // Folded, the bar has no size: it keeps the last one it had, for where it unfolds.
    if (!scroller || !content || content.offsetHeight === 0) return;
    const height = content.offsetHeight + 2;
    setBarHeight(height);
    setContentMeasured(true);
    if (dockStore.getState().lastHeight !== height) dockStore.setState({ lastHeight: height });
    const cut = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 4;
    setClipped(cut);
    const header = content.querySelector<HTMLElement>(`[${STICKY_HEADER_ATTR}]`);
    // The fade is the scroller's last child where it draws, a zero-height row whose one child is the drawn fade.
    const last = scroller.lastElementChild;
    const fade = cut && last instanceof HTMLElement && last.hasAttribute(SCROLL_FADE_ATTR) ? (last.firstElementChild as HTMLElement | null) : null;
    const next = { top: header?.offsetHeight ?? 0, bottom: fade?.offsetHeight ?? 0 };
    setPad((prev) => (prev.top === next.top && prev.bottom === next.bottom ? prev : next));
  };
  // One wrapper holds every section, so a section that opens after the bar does (the conditions drawer, death saves) resizes it too.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  // Every mode places a bar, so a placement always comes back. While someone types in it, it keeps its mode: a page a browser shrinks for its keyboard would turn it compact under the field (docs/design.md 14.4).
  const typingHere = useTypingWithin(barRef);
  const lastMode = useRef<BarMode | null>(null);
  /*
   * Where its body under the bars is too short for the field typed in and
   * what goes with it, as a window on a phone held sideways at 130%, it
   * takes the visible area from its top, over the bars, until the keyboard
   * closes: never as focus moves on to Spend, which a tap would miss.
   */
  const [overBars, setOverBars] = useState(false);
  const placed = placeBar({ layout, viewport: props.viewport, chrome, foot, spot, height: barHeight, column, width, size, resizable: finePointer, heldMode, cardAt, state: restState, expandedHeight, restFoot, typing, keepMode: typingHere ? lastMode.current : null, overBars: overBars && typing !== null })!;
  lastMode.current = placed.mode;
  const { free, mode, resizable } = placed;
  // Over the keyboard the room is the field's: no "Scroll for more" lies over it or what goes with it.
  const fades = clipped && !(mode === "span" && restState === "rest") && !(typingHere && typing !== null);
  // The fade's height, once it shows or goes.
  useLayoutEffect(measure, [fades]);
  useLayoutEffect(() => {
    if (typing === null) setOverBars(false);
    // Once the scroll padding has dropped the fade that went, as bodyHoldsField reads it.
    else if (!overBars && !(pad.bottom > 0 && !fades) && scrollRef.current && bodyHoldsField(scrollRef.current, theme.space(2)) === false) setOverBars(true);
  });
  // The strip and the expanded bar draw exactly their room, never their content's height (3.1).
  const drawnHeight = mode === "span" ? placed.hang.room : barHeight;

  // Actions in the Multi-select bar shows the bar and focuses its frame, once it is drawn.
  useLayoutEffect(() => {
    if (!dockStore.getState().focusFrame) return;
    dockStore.setState({ focusFrame: false });
    if (!folded) barRef.current?.focus({ preventScroll: true });
  }, [folded, dockStore]);

  /*
   * The box the bar draws, for the column, the notices and the camera. A
   * drag or a resize publishes nothing new until it ends, so the column does
   * not jump as the bar passes under it. Only a drag that moved holds it
   * back: a plain press on the header publishes as ever, and the end of a
   * drag, dropped, put back by Escape or cancelled, publishes the latest,
   * alerts that arrived meanwhile included.
   */
  const facts: BarFacts | null = folded ? null : { box: hangBox(placed.hang, drawnHeight), mode, lane: placed.lane, laneLeft: laneLeft(free), freeRight: free.left + free.width, ...(mode === "span" && restState === "rest" ? { rests: true } : null) };
  const factsKey = facts ? JSON.stringify(facts) : "";
  const dragging = dragBox !== null;
  useLayoutEffect(() => {
    if (dragging) return;
    dockStore.setState({ bar: facts });
    // The facts are read through factsKey, which changes exactly when they do.
  }, [factsKey, dockStore, dragging]);
  useLayoutEffect(() => () => dockStore.setState({ bar: null }), [dockStore]);

  const setSpot = (next: Spot) => {
    dockStore.setState({ spot: next });
    if (!preview) writeSpot(next);
  };
  const setSize = (next: BarSize) => {
    dockStore.setState({ size: next });
    if (!preview) writeSize(next);
  };

  /*
   * The strip's mode is held from the moment it shows (2), so a free area
   * that shrinks later never turns it compact. Stage lets it go as the
   * selection goes, the screen turns or the interface size changes.
   */
  useLayoutEffect(() => {
    if (mode === "span" && dockStore.getState().heldMode !== "span") dockStore.setState({ heldMode: "span" });
  }, [mode, dockStore]);

  /*
   * Expand and Collapse (5.3). The expanded bar's height is worked out at
   * Expand, for each new token (each token's bar is a frame of its own)
   * and on a change of the map's frame, from its content then, and frozen
   * otherwise (5.1, review BC-OPUS-8): a stat block that loads late or a
   * drawer opened inside scrolls under Scroll for more. The dock store
   * keeps what it was worked out for, since a drag unmounts the frame
   * and the bar it shows again is the same token's (3.6). Collapse moves
   * nothing (R3). Expand moves the map once, as a clear request does, for
   * the expanded bar's top (5.2).
   */
  const expand = () => {
    shiftOnExpand.current = true;
    dockStore.setState({ expanded: true, expandedHeight: null, expandedFor: null });
  };
  const collapse = () => dockStore.setState({ expanded: false, expandedHeight: null, expandedFor: null });
  const shiftOnExpand = useRef(false);
  // The column's content counts, since a card that comes after the first changes the room it leaves (barDock.ts firstFoot).
  const frozenKey = JSON.stringify([props.opening, layout.width, layout.height, props.viewport.width, props.viewport.height, chrome, restFoot, column ? [column.top, column.first, column.content] : null]);
  useLayoutEffect(() => {
    if (restState !== "expanded") return;
    const content = contentRef.current;
    if (dockStore.getState().expandedFor === frozenKey || !content || content.offsetHeight === 0) return;
    const height = expandedRoom({ layout, free: stripFree, column, content: content.offsetHeight + 2 * theme.line.border });
    dockStore.setState({ expandedHeight: height, expandedFor: frozenKey });
  });

  /*
   * The clearing move (3.6, 5.2): once for each clear request this frame
   * can use, as the viewer opens the bar, shows another token in it or
   * drops a token, and once at the Expand press, after the expanded bar's
   * height is known and before paint. The move clears the token's label
   * of the bar's top and goes through Stage, which bounds it by the
   * camera's limits (lib/camera.ts barShift). An expanded bar clears the
   * token of its own top, its frozen height, and stays expanded, a drop
   * included (5.3, D-261024-22). A docked, compact or folded bar drops a
   * request. A request for another token is not this frame's.
   */
  const spanToast = useScoped(spanToastSlot);
  const [waited, setWaited] = useState<typeof clearRequest>(null);
  useLayoutEffect(() => {
    const request = clearRequest;
    if (request === null && !shiftOnExpand.current) return;
    const wait = request !== null && request !== waited ? clearWaitMs() : 0;
    if (wait > 0) {
      const timer = setTimeout(() => setWaited(request), wait);
      return () => clearTimeout(timer);
    }
    const mine = request !== null && (props.opening === "group" || request.tokenId === props.opening);
    const usable = mode === "span" && !folded;
    if (usable && restState === "expanded" && expandedHeight === null) return;
    const asked = usable && (shiftOnExpand.current || mine);
    shiftOnExpand.current = false;
    if (request !== null) dockStore.setState({ clearRequest: null });
    if (!asked) return;
    const top = hangBox(placed.hang, placed.hang.room).top;
    const dy = clearShift({ anchor: props.anchor, tokenHeight: props.tokenHeight, free: stripFree, barTop: top, toastFoot: spanToast.foot });
    if (dy !== 0) props.onShift?.(dy);
    // Read as the request comes, from the frame as it stands then.
  }, [clearRequest, restState, expandedHeight, mode, folded, waited]);

  /*
   * Where the expanded bar's header stands, for the toasts (barDock.ts
   * spanToastSlot): a toast that shows over it moves under it, so Close
   * and Collapse stay in reach (review LP19-BS-2). The resting strip
   * publishes no header, since the toasts keep above it (3.5, its box in
   * the dock store's `bar`). Read after each render, without drawing
   * anything again, except that while the header
   * opens, and once it goes down into the toasts placed under it, the
   * toasts look again (headAsksToasts, reviews LP19-Q1 and LP19-OPUS-3).
   * Each time the header shows it starts a new opening, the key that owns
   * a stack of toasts placed under it (barStack, review FU24-OPUS-1). A
   * count, since two openings can fall in the same millisecond.
   */
  useLayoutEffect(() => {
    const header = mode === "span" && restState === "expanded" && !folded ? barRef.current?.querySelector<HTMLElement>(`[${STICKY_HEADER_ATTR}]`) : null;
    const box = header?.getBoundingClientRect();
    const head = box && box.height > 0 ? { top: box.top / zoom, bottom: box.bottom / zoom } : null;
    const was = spanToast.head;
    spanToast.head = head;
    if (head === null) {
      spanToast.shownAt = null;
      spanToast.opening = null;
      return;
    }
    const now = Date.now();
    if (was === null) {
      spanToast.shownAt = now;
      spanToast.opening = ++spanToast.openings;
    }
    const moved = was === null || was.top !== head.top || was.bottom !== head.bottom;
    if (moved && headAsksToasts(spanToast, head, now)) spanToast.recheck?.();
  });
  useLayoutEffect(
    () => () => {
      spanToast.head = null;
      spanToast.shownAt = null;
      spanToast.opening = null;
    },
    [spanToast],
  );
  // A request left when the frame goes is for a bar no longer shown: a close, a switch away from Select, a drag's start or a blackout.
  useLayoutEffect(
    () => () => {
      if (dockStore.getState().clearRequest !== null) dockStore.setState({ clearRequest: null });
    },
    [dockStore],
  );
  /*
   * Escape or a cancelled pointer during a drag or a resize puts the window
   * back as the drag began and keeps it open, storing nothing. A press on
   * the header focuses the frame, so the header never sees the key: a
   * capture listener on the window, there only while a drag is under way,
   * takes it first, and its preventDefault leaves Room's Escape
   * (RoomChrome.tsx useEscape) alone.
   */
  const endDrag = useRef(() => {});
  const onEscape = useRef((e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    endDrag.current();
  });
  endDrag.current = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("keydown", onEscape.current, true);
    if (drag?.el.hasPointerCapture(drag.pointerId)) drag.el.releasePointerCapture(drag.pointerId);
    setDragBox(null);
  };
  useEffect(() => () => window.removeEventListener("keydown", onEscape.current, true), []);
  // A rotation that changes how the window opens ends a drag under way, storing nothing (5.4).
  useEffect(() => {
    if (dragRef.current) endDrag.current();
  }, [mode, resizable]);
  const layerBox = (el: HTMLElement): Box | null => {
    const layer = el.offsetParent;
    if (!layer) return null;
    const r = el.getBoundingClientRect();
    const l = layer.getBoundingClientRect();
    return { left: (r.left - l.left) / zoom, top: (r.top - l.top) / zoom, width: r.width / zoom, height: r.height / zoom };
  };

  /** A press that may become a move of the window, or a resize by its handle or a band. */
  const startDrag = (e: ReactPointerEvent<HTMLElement>, kind: Drag["kind"]) => {
    const frame = barRef.current;
    const start = frame ? layerBox(frame) : null;
    if (!start) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const limits = resizeLimits({ box: start, corner: spot.corner, room: placed.room, defaultWidth: width, content: barHeight });
    dragRef.current = { kind, pointerId: e.pointerId, el: e.currentTarget, x: e.clientX, y: e.clientY, start, box: null, limits };
  };
  const dragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    // A short press moves and resizes nothing: the window changes once the pointer passes the slop a tap on the map has.
    if (!drag.box && Math.hypot(dx, dy) <= TAP_SLOP_PX) return;
    if (!drag.box) window.addEventListener("keydown", onEscape.current, true);
    drag.box =
      drag.kind === "move"
        ? clampMove({ ...drag.start, left: drag.start.left + dx / zoom, top: drag.start.top + dy / zoom }, free, resizable)
        : resizeBox({ start: drag.start, corner: spot.corner, part: drag.kind, dx: dx / zoom, dy: dy / zoom, limits: drag.limits });
    setDragBox(drag.box);
  };
  const dragUp = (e: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.box && drag.kind === "move") {
      setSpot(releaseSpot(drag.box, free));
      say("");
    } else if (drag.box) {
      // The anchored edges keep the spot's corner, and the far edges store the new size (5.4).
      setSize(releaseSize({ stored: size, start: drag.start, box: drag.box, defaultWidth: width, tallest: drag.limits.maxHeight }));
      setSpot(anchoredSpot(drag.box, free, spot.corner));
      revealFocusSoon.current = true;
    }
    endDrag.current();
  };
  const dragCancel = (e: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) endDrag.current();
  };
  /*
   * After a resize ends, a focused control the new size hides scrolls into
   * view, inside the scroll padding (5.8). It runs after the render that
   * draws the new size.
   */
  const revealFocusSoon = useRef(false);
  useLayoutEffect(() => {
    if (!revealFocusSoon.current) return;
    revealFocusSoon.current = false;
    const active = document.activeElement;
    if (active instanceof HTMLElement && scrollRef.current?.contains(active)) active.scrollIntoView({ block: "nearest" });
  });

  const handle: PaneHandle | null =
    mode === "dock"
      ? {
          dragging: dragBox !== null,
          onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
            if (e.button !== 0 || dragRef.current) return;
            // The grip is a button that takes the drag too. The header's other buttons keep their presses.
            if (e.target instanceof Element && e.target.closest("button, a, input, select, textarea") && !e.target.closest(`[${GRIP_ATTR}]`)) return;
            startDrag(e, "move");
          },
          onPointerMove: dragMove,
          onPointerUp: dragUp,
          onPointerCancel: dragCancel,
          grip: {
            label: "Move window",
            description: "Drag to move the window. With this focused, the arrow keys move it, and Shift moves it faster. Reset, beside Close, puts it back.",
            onKeyDown: moveByKeys,
          },
        }
      : null;
  /*
   * The grip's arrow keys (docs/design-v1-token-window.md 4.3): each step
   * starts from the box as drawn, so a step the lane took back starts from
   * where the lane put the window, is clamped into its room, and is stored
   * at once as the nearest corner's spot, unsnapped. The handled key's
   * default is prevented, so the room's shortcuts pass over it and no
   * selected token moves. Escape is left to close the bar.
   */
  function moveByKeys(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = arrowStep(e.key, e.shiftKey);
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const frame = barRef.current;
    const box = frame ? layerBox(frame) : null;
    if (!box) return;
    setSpot(keySpot(clampMove({ ...box, left: box.left + step.dx, top: box.top + step.dy }, free, resizable), free));
    sayAtRest(() => spotWords(dockStore.getState().spot));
  }
  /*
   * The handle's arrow keys (5.5) move its corner 8 px, or 64 with Shift,
   * with the sense of a drag of it, and store each press at once, unsnapped.
   * A press against a limit changes nothing, and the status says which.
   */
  function resizeByKeys(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const step = arrowStep(e.key, e.shiftKey);
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const frame = barRef.current;
    const box = frame ? layerBox(frame) : null;
    if (!box) return;
    const limits = resizeLimits({ box, corner: spot.corner, room: placed.room, defaultWidth: width, content: barHeight });
    const next = resizeBox({ start: box, corner: spot.corner, part: "corner", dx: step.dx, dy: step.dy, limits });
    const limit = limitMet({ start: box, box: next, dx: step.dx, dy: step.dy, corner: spot.corner, limits });
    if (Math.abs(next.width - box.width) > 0.5 || Math.abs(next.height - box.height) > 0.5) {
      setSize(keySize({ stored: size, start: box, box: next, defaultWidth: width, tallest: limits.maxHeight }));
      setSpot(anchoredSpot(next, free, spot.corner));
      revealFocusSoon.current = true;
    }
    sayAtRest(() => sizeWords(next, limit));
  }
  // A size stored on a device whose window does not resize counts as none (4.4).
  const moved = !isDefaultSpot(spot) || (finePointer && hasSize(size));
  /*
   * Reset leaves with the press that brings the window home, or with a drag
   * back to its default. Whatever takes it away while it has focus, focus
   * goes to Close rather than to the page (4.4).
   */
  const resetFocused = useRef(false);
  useLayoutEffect(() => {
    if (moved || !resetFocused.current) return;
    resetFocused.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) closeRef.current?.focus();
  }, [moved]);
  const place: FrameControls["place"] =
    mode === "dock"
      ? {
          moved,
          closeRef,
          onResetFocus: (focused) => {
            resetFocused.current = focused;
          },
          reset: () => {
            // Reset goes away with the press, so focus moves to Close first.
            resetFocused.current = false;
            closeRef.current?.focus();
            setSpot(DEFAULT_SPOT);
            setSize(NO_SIZE);
            say(RESET_WORDS);
          },
        }
      : null;
  // Read from where the bar stands at rest, never from its content or a drag under way, so the short layout, an opened "More stats" and a resize never flip it mid-gesture.
  const short = barShort({ layout, viewport: props.viewport, chrome, foot, restFoot, anchor: props.anchor, spot, column, width, size, resizable: finePointer, heldMode, cardAt });
  const header = mode === "dock" ? headerLayout(placed.hang.width, finePointer) : WHOLE_HEADER;
  const rest: FrameControls["rest"] = mode === "span" ? { resting: restState === "rest", scrolls, expand, collapse, words: placed.hang.width >= EXPAND_WORDS_MIN } : null;
  /*
   * The scrolling strip (5.4): Scroll for more brings the row at its foot
   * to its top, its window less a quick row, and the header and quick row
   * come back as the HP field takes focus or an error shows.
   */
  const toTop = () => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = 0;
  };
  const strip: StripControls | null =
    mode === "span"
      ? {
          scrollMore: () => {
            const scroller = scrollRef.current;
            if (scroller) scroller.scrollBy({ top: Math.max(0, scroller.clientHeight - theme.touch) });
          },
          toTop,
          summary: headerSummary,
        }
      : null;
  const controls: FrameControls = { handle, sticky: mode === "dock" || (mode === "span" && !scrolls), place, rest, header, short, raise: setRaised, strip };

  const { hang } = placed;
  // Placed on the page as it is while someone types, which a browser may have made shorter than the room it keeps (barDock.ts Typing).
  const pageHeight = typing ? typing.page : props.viewport.height;
  const where = dragBox
    ? heldPlace(dragBox, spot.corner, props.viewport)
    : mode === "span"
      ? { left: hang.left, bottom: pageHeight - hang.at, width: hang.width, height: hang.room }
      : hang.anchor === "top"
        ? { left: hang.left, top: hang.at, width: hang.width, maxHeight: hang.room }
        : { left: hang.left, bottom: pageHeight - hang.at, width: hang.width, maxHeight: hang.room };
  // The resting strip's paddings and gap, which give way in that order where the free area makes it shorter than 114 (3.1).
  const pads = mode === "span" && restState === "rest" ? stripPads(hang.room) : null;
  // The handle stands at the corner opposite the spot's, and its bands along the two edges that meet there (5.3).
  const handleAt = handleCorner(spot.corner);
  const resizeHandlers = (kind: ResizePart) => ({
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0 || dragRef.current) return;
      startDrag(e, kind);
    },
    onPointerMove: dragMove,
    onPointerUp: dragUp,
    onPointerCancel: dragCancel,
  });
  const corner = resizeHandlers("corner");
  return (
    <div
      ref={barRef}
      role="dialog"
      aria-label={props.label}
      hidden={folded}
      data-bar-mode={mode}
      data-bar-state={mode === "span" ? (scrolls ? "scrolls" : restState) : undefined}
      // Focusable from script, not by Tab: the dock's Show, a closing sheet and Actions move focus here, which announces the bar and opens no keyboard.
      tabIndex={-1}
      style={{
        position: "absolute",
        ...where,
        // The frame keeps the box, and a scroller inside it scrolls, so the handle and its bands stand outside what scrolls and clips (5.7).
        display: "flex",
        flexDirection: "column",
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        boxShadow: theme.shadow.pane,
        color: theme.color.text,
        fontSize: theme.font.body14,
        zIndex: raised ? theme.z.popover : overBars && typing !== null ? theme.z.overBars : mode === "compact" ? theme.z.barOverlay : theme.z.pane,
      }}
    >
      <div
        ref={scrollRef}
        data-bar-scroll=""
        onScroll={measure}
        onFocus={(e) => {
          // The HP field taking focus brings the scrolling strip's header and quick row back into view (5.4).
          if (scrolls && e.target instanceof Element && e.target.closest("[data-rest-row]") && e.target.matches("input")) toTop();
        }}
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          overscrollBehavior: "contain",
          borderRadius: theme.radius.lg - theme.line.border,
          scrollbarWidth: "thin",
          scrollPaddingTop: pad.top,
          scrollPaddingBottom: pad.bottom,
        }}
      >
        <FrameContext.Provider value={controls}>
          <div
            ref={contentRef}
            style={{
              padding: pads ? `${pads.top}px ${theme.space(3)}px ${pads.bottom}px` : `${theme.space(1)}px ${theme.space(3)}px ${theme.space(3)}px`,
              display: "grid",
              // One column no wider than the bar: an auto column grows to its widest unbreakable child, such as a long name, and pushes the buttons out of view.
              gridTemplateColumns: "minmax(0, 1fr)",
              gap: pads ? pads.gap : theme.space(2),
            }}
          >
            {props.children}
          </div>
        </FrameContext.Provider>
        {fades ? <ScrollForMore /> : null}
      </div>
      {resizable && !folded ? (
        <>
          <div aria-hidden data-resize-band="" {...resizeHandlers("height")} style={bandStyle(handleAt, "height")} />
          <div aria-hidden data-resize-band="" {...resizeHandlers("width")} style={bandStyle(handleAt, "width")} />
          <button
            type="button"
            aria-label="Resize window"
            data-resize-handle=""
            // A press that starts a drag closes the tooltip, as any mouse press on a control does.
            {...handleTip.anchor({ onPointerDown: corner.onPointerDown, onPointerUp: corner.onPointerUp, onPointerCancel: corner.onPointerCancel, "aria-describedby": handleDescription })}
            onPointerMove={corner.onPointerMove}
            onKeyDown={resizeByKeys}
            style={handleStyle(handleAt, dragBox !== null)}
          >
            <Icon name="resize" size={16} style={handleAt === "tr" || handleAt === "bl" ? { transform: "rotate(90deg)" } : undefined} />
          </button>
          {handleTip.tip}
          <span id={handleDescription} style={VISUALLY_HIDDEN}>
            Drag to resize the window. With this focused, the arrow keys resize it, and Shift resizes it faster. Reset, beside Close, puts it back.
          </span>
        </>
      ) : null}
      <div role="status" style={VISUALLY_HIDDEN}>
        {status}
      </div>
    </div>
  );
}

/**
 * The resting strip's top padding, the gap between its header and quick
 * row, and its bottom padding (3.1): 4, 8 and 8 at its 114 px, given up in
 * that order as the strip shortens, so its header and quick row stay whole
 * down to 94.
 */
function stripPads(height: number): { top: number; gap: number; bottom: number } {
  let short = Math.max(0, Math.min(REST_HEIGHT - REST_TIGHT, REST_HEIGHT - height));
  const give = (pad: number) => {
    const given = Math.min(pad, short);
    short -= given;
    return pad - given;
  };
  const top = give(theme.space(1));
  const gap = give(theme.space(2));
  return { top, gap, bottom: give(theme.space(2)) };
}

/** The resize handle's disc. Its center sits on the frame's outer corner, so half of it lies past the window, inside the handle's reach (barDock.ts HANDLE_REACH). */
const HANDLE_PX = 24;
/** The edges' bands, just outside the border. */
const BAND_PX = 8;

function handleStyle(at: Corner, dragging: boolean): CSSProperties {
  const off = -(HANDLE_PX / 2) - theme.line.border;
  return {
    position: "absolute",
    [at[0] === "t" ? "top" : "bottom"]: off,
    [at[1] === "l" ? "left" : "right"]: off,
    width: HANDLE_PX,
    height: HANDLE_PX,
    padding: 0,
    display: "grid",
    placeItems: "center",
    borderRadius: theme.radius.pill,
    background: theme.color.surface,
    border: `${theme.line.border}px solid ${theme.color.border}`,
    color: theme.color.textMuted,
    cursor: at === "tl" || at === "br" ? "nwse-resize" : "nesw-resize",
    touchAction: "none",
    zIndex: 2,
    ...(dragging ? { color: theme.color.accent } : null),
  };
}

/** A band along the edge at the handle's side: across the top or bottom for the height, down the left or right for the width. */
function bandStyle(at: Corner, part: "width" | "height"): CSSProperties {
  const off = -BAND_PX - theme.line.border;
  const band: CSSProperties =
    part === "height"
      ? { left: 0, right: 0, height: BAND_PX, [at[0] === "t" ? "top" : "bottom"]: off, cursor: "ns-resize" }
      : { top: 0, bottom: 0, width: BAND_PX, [at[1] === "l" ? "left" : "right"]: off, cursor: "ew-resize" };
  return { position: "absolute", touchAction: "none", zIndex: 1, ...band };
}

/**
 * How tall the fade of "Scroll for more" stands over its box's foot: 24 px
 * of fade above the line, a 16 px line and 8 px under it. A control that
 * scrolls into view above the fade keeps this much clear of the foot
 * (features/attach/AttachButton.tsx).
 */
export const SCROLL_FOR_MORE_PX = theme.space(12);

/**
 * "Scroll for more", laid over the foot of a box that scrolls while
 * anything is hidden below. It has no height of its own, so it never adds
 * to what scrolls, and screen readers skip it: they reach every control by
 * moving through them. The alerts column shows it too wherever it cuts
 * its cards short (features/encounter/InitiativeStrip.tsx), and a popover
 * (components/Popover.tsx). Its fade ends in `surface`, the color of the
 * boxes it covers. As wide as its box, so in a row that wraps it takes a
 * line of its own. At `edge` "top", first in its box, it lies over the
 * box's top instead, for a stack of toasts that keeps its newest, at its
 * foot, in view and hides the older above (pages/Room.tsx Toasts).
 */
/** Marks ScrollForMore's row, so a scroller can find its fade among its children. */
const SCROLL_FADE_ATTR = "data-scroll-fade";

export function ScrollForMore(props: { inset?: number; edge?: "top" | "foot" }) {
  // A sticky box keeps inside its scroller's padding: `inset` is that box's bottom padding, so the fade still lies on its foot.
  const inset = props.inset ?? 0;
  const top = props.edge === "top";
  return (
    <div aria-hidden {...{ [SCROLL_FADE_ATTR]: "" }} style={{ position: "sticky", ...(top ? { top: -inset } : { bottom: -inset }), width: "100%", height: 0, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          ...(top ? { top: 0 } : { bottom: 0 }),
          padding: top ? `${theme.space(2)}px ${theme.space(3)}px ${theme.space(6)}px` : `${theme.space(6)}px ${theme.space(3)}px ${theme.space(2)}px`,
          background: `linear-gradient(${top ? "to top, " : ""}transparent, ${theme.color.surface} 60%)`,
          color: theme.color.textMuted,
          fontSize: theme.font.small,
          lineHeight: `${SCROLL_FOR_MORE_PX - theme.space(8)}px`,
          textAlign: "center",
        }}
      >
        Scroll for more
      </div>
    </div>
  );
}

/**
 * One tap adds or removes. Each button shows its name under the icon,
 * since a touch screen has no hover to read a title from. Levels, spells,
 * durations and the rules text live in Details, so the bar, which loads
 * with the map for everyone, carries no SRD text.
 */
function QuickConditions(props: { lit(key: Effect["key"]): Lit; onToggle(key: Effect["key"]): void }) {
  // In a window shrunk short the drawer opens above the rows, out of sight without this (docs/design-v1-token-window.md 5.7).
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
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
    <div ref={ref} style={{ display: "grid", gap: theme.space(2) }}>
      {group("Conditions", CONDITION_KEYS)}
      {group("Other statuses", STATUS_KEYS)}
    </div>
  );
}

/**
 * Dismiss, for a companion's owners who are not the DM, in Delete's place
 * (docs/design-v1-combat-flow.md 3.6.9): armed as Delete is, and busy until
 * the server answers, since it can take a row out of the fight and pass a
 * turn on. The token, and with it this bar, goes when it does.
 *
 * The Token panel, which stays, passes `handOff`, told of the confirming
 * press while the button still stands, to hand focus on once it has gone
 * (D-261024-47). A refusal leaves the button, and focus on it.
 */
export function DismissButton(props: { tokenId: string; name: string; handOff?(button: HTMLElement): void }) {
  const inRow = useContext(InButtonRow);
  const [armed, setArmed] = useState(false);
  const { send, waiting } = useSend();
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const text = armed ? `Dismiss ${props.name}?` : "Dismiss";
  return (
    <Button
      size="sm"
      variant="danger"
      armed={armed}
      busy={waiting}
      aria-label={text}
      onClick={(e) => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        props.handOff?.(e.currentTarget);
        send({ t: "token.delete", tokenId: props.tokenId });
      }}
      style={{ flex: inRow ? ROW_BUTTON_FLEX : "none" }}
    >
      {text}
    </Button>
  );
}

/**
 * Delete, armed by its first tap. `holdsRoom` gives it a slot as wide as
 * its armed form, the trash can at the slot's start, so arming grows it
 * over the slot and never wraps it to another line, where the second tap,
 * aimed at the trash can, would land on nothing (docs/design-v1-icons.md
 * 3.1 rule 6). The single token's bar takes it: on a tablet or a phone
 * held sideways, Locked and Duplicate with their words leave room for the
 * trash can alone. The group bar's Clear follows its Delete, so a slot
 * there would leave a gap before it. In a bar row the button fills its
 * slot, which grows to share its line (ButtonRow), so arming changes only
 * its words.
 */
function DeleteButton(props: { onDelete(): void; armedText?: string; holdsRoom?: boolean }) {
  const inRow = useContext(InButtonRow);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [armed]);
  const words = deleteButtonWords(armed, props.armedText);
  const button = (
    <BarButton
      danger
      armed={armed}
      icon="delete"
      // A trash can is read at once on any screen (docs/design-v1-icons.md 2), so Delete is its icon alone until armed, when "Sure?" shows beside it.
      iconOnly={!armed}
      always={!armed}
      label={words.label}
      onClick={() => {
        if (armed) props.onDelete();
        else setArmed(true);
      }}
    >
      {words.text}
    </BarButton>
  );
  if (!props.holdsRoom) return button;
  return (
    <span style={{ display: "inline-grid", flex: inRow ? ROW_BUTTON_FLEX : "none" }}>
      <ButtonGhost size="sm" icon="delete" style={{ gridArea: "1 / 1" }}>
        {deleteButtonWords(true, props.armedText).text}
      </ButtonGhost>
      <span style={{ gridArea: "1 / 1", display: "flex" }}>{button}</span>
    </span>
  );
}

/**
 * The creature's size on the map (docs/design-v1-token-window.md 8.9): a
 * stepper as Elevation is, one size a press, Reduce and Enlarge being one
 * size, with the size between the buttons in a slot as wide as
 * "Gargantuan", so the buttons never move under the thumb. A Custom size
 * is shown, set by the DM in Stats. A refusal is the room's toast, and the
 * size stays. Focus stays on the button pressed, or moves to the other one
 * where a press reaches Tiny or Gargantuan and disables it.
 */
function SizeRow(props: { token: ViewToken; owner: boolean; canResize: boolean }) {
  const { token } = props;
  const resize = useResize();
  const smaller = useRef<HTMLButtonElement>(null);
  const larger = useRef<HTMLButtonElement>(null);
  if (token.size === "custom" || !props.canResize) {
    return (
      <StepperRow label="Size" group>
        <span style={{ fontWeight: theme.weight.bold, overflowWrap: "anywhere" }}>{token.size === "custom" ? customWords(token, props.owner) : SIZE_WORDS[token.size]}</span>
      </StepperRow>
    );
  }
  const down = stepSize(token.size, -1);
  const up = stepSize(token.size, 1);
  const press = (to: Exclude<Token["size"], "custom">, by: 1 | -1) => {
    // The button pressed is disabled once the size reaches an end, so focus moves to the other, before the render that disables it.
    if (resize(token, { size: to }) === null && stepSize(to, by) === null) (by === 1 ? smaller : larger).current?.focus();
  };
  return (
    <StepperRow label="Size" group>
      <BarButton ref={smaller} label="One size smaller" icon="minus" iconOnly always disabled={down === null} onClick={() => down && press(down, -1)} />
      <span style={{ display: "inline-grid", textAlign: "center", fontWeight: theme.weight.bold }}>
        <span aria-hidden style={{ gridArea: "1 / 1", visibility: "hidden" }}>
          Gargantuan
        </span>
        <span aria-live="polite" style={{ gridArea: "1 / 1" }}>
          {SIZE_WORDS[token.size]}
        </span>
      </span>
      <BarButton ref={larger} label="One size larger" icon="plus" iconOnly always disabled={up === null} onClick={() => up && press(up, 1)} />
    </StepperRow>
  );
}

/**
 * A label and its stepper, such as Elevation's −5 and +5, on one line, or
 * the stepper under the label, right-aligned, where the window is too
 * narrow for both, as beside a phone's sideways sheet or on the narrowest
 * phone's spanning bar (docs/design-v1-token-window.md 8.9). One rule keeps
 * every stepper row inside the window at any width and font.
 */
function StepperRow(props: { label: string; children: ReactNode; group?: boolean }) {
  return (
    <div role={props.group ? "group" : undefined} aria-label={props.group ? props.label : undefined} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
      <span style={{ flex: "1 1 auto", color: theme.color.textMuted }}>{props.label}</span>
      <div style={{ flex: "none", marginLeft: "auto", display: "flex", alignItems: "center", gap: theme.space(1), fontVariantNumeric: "tabular-nums" }}>{props.children}</div>
    </div>
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
  /** The words, which an icon alone keeps as its name. An icon alone named by `label` needs none. */
  children?: ReactNode;
  label?: string;
  pressed?: boolean;
  half?: boolean;
  danger?: boolean;
  armed?: boolean;
  grow?: boolean;
  disabled?: boolean;
  /** Waiting: it shows so and ignores taps (components/Button.tsx). */
  busy?: boolean;
  /** Drawn before the words (docs/design-v1-icons.md 4). */
  icon?: IconName;
  /** The icon alone, its words its name and tooltip, where a mouse can hover. A touch screen keeps the words. */
  iconOnly?: boolean;
  /** The icon alone on every screen: only for an icon read at once without hover, such as the trash can. */
  always?: boolean;
}) {
  const inRow = useContext(InButtonRow);
  return (
    <Button
      ref={props.ref}
      size="sm"
      variant={props.danger ? "danger" : "secondary"}
      disabled={props.disabled}
      busy={props.busy}
      armed={props.armed}
      pressed={props.half ? undefined : props.pressed}
      aria-pressed={props.half ? "mixed" : props.pressed}
      aria-label={props.label}
      title={props.label}
      icon={props.icon}
      iconOnly={props.iconOnly ? (props.always ? "always" : "fine") : undefined}
      onClick={props.onClick}
      style={{
        flex: inRow ? ROW_BUTTON_FLEX : props.grow ? "1 0 auto" : "none",
        ...(props.half ? { background: theme.color.surfaceRaised, border: `${theme.line.border}px dashed ${theme.color.accent}`, color: theme.color.text } : null),
      }}
    >
      {props.children}
    </Button>
  );
}

// ------------------------------------------------------------ an upright phone's resting strip (docs/design-v1-bar-compact.md 3.3)

/** The entry with nothing to say: the status line shows the vitals. */
const QUIET_ENTRY: EntryStatus = { error: null, dead: null, preview: null, typed: false, crit: false, reach: 1, left: [], standing: null };

/** The vitals the short layout keeps, as the status line's parts: "AC 14", then "HP 24/24" or a player's "Healthy". */
function vitalsWords(items: readonly VitalItem[]): string[] {
  return items.flatMap((item) => {
    if (item.key === "ac") return item.units.flatMap((u) => (u.kind === "ac" ? [`AC ${u.ac}`] : []));
    if (item.key === "hp") return [item.units.map(unitText).join(" ")];
    return [];
  });
}

/** The widths a status text is measured against: the title's, drawn and in the chrome's own px, and the note's text. */
type StatusBox = { lineDrawn: number; line: number; note: number };

/** The status line's and the header's sentences' lines (TokenActionBar.tsx BarHeader's SENTENCE_LINES). */
const STATUS_LINE_PX = 18;

/**
 * The strip's status line (barButtons.ts restStatus), measured where it
 * draws: the line under the name, the title's two lines and the note's
 * two lines, each by the drawn width of its text in the status font,
 * inside the chrome's zoom. `node` is what the header draws under the
 * name, `probe` the hidden measure the bar draws once in its content,
 * and `status.sentence` what the header draws over its title or in its
 * note. All three are measured against the header's title, which stands
 * whatever fills it (the name and the line, or a sentence), so a width
 * that changes while a sentence holds the title is still read, and the
 * choice never flips back and forth.
 *
 * The note goes as the field empties, Apply succeeds (which empties it)
 * or focus leaves the strip, and comes back as focus returns or the
 * sentence changes (3.3). The title's line shows the vitals meanwhile,
 * as it does under the note, and the field keeps the entry's whole
 * sentence as its description.
 */
function useRestStatus(input: { entry: EntryStatus; idle: readonly string[]; critInRow: boolean; active: boolean }): { status: RestStatus; node: ReactNode; probe: ReactNode } {
  // State, not a ref, so a probe drawn afresh as the strip rests again finds its frame and title again.
  const [host, setHost] = useState<HTMLSpanElement | null>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<StatusBox | null>(null);
  const key = JSON.stringify([input.entry, input.idle, input.critInRow]);
  const [measured, setMeasured] = useState<RestStatus>(() => restStatus({ ...input.entry, idle: input.idle, critInRow: input.critInRow, fit: FITS_ALL }));
  // The whole sentence that stood as focus left the strip, which keeps its note away until focus comes back or the sentence changes.
  const [away, setAway] = useState<string | null>(null);
  const full = useRef(measured.full);
  useLayoutEffect(() => {
    full.current = measured.full;
    if (away !== null && away !== measured.full) setAway(null);
  }, [measured.full, away]);
  // Read again as the frame or the title changes width: a turn, a new interface size, a header button.
  useLayoutEffect(() => {
    const frameEl = host?.closest<HTMLElement>('[role="dialog"]');
    // The header's title (SheetHeader.tsx PaneHeader's), the frame's first strong, ahead of everything the content draws.
    const title = frameEl?.querySelector<HTMLElement>("strong");
    if (!input.active || !frameEl || !title) return;
    const read = () => {
      // The note's words stand NOTE_INSET in from its edges, and the note is as wide as the frame (BarHeader's NOTE_BOX).
      const next = { lineDrawn: title.getBoundingClientRect().width, line: title.clientWidth, note: frameEl.offsetWidth - 2 * theme.line.border - 2 * NOTE_INSET };
      setBox((now) => (now && now.lineDrawn === next.lineDrawn && now.line === next.line && now.note === next.note ? now : next));
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(title);
    watch.observe(frameEl);
    const leave = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && frameEl.contains(event.relatedTarget))) setAway(full.current);
    };
    const enter = () => setAway(null);
    frameEl.addEventListener("focusout", leave);
    frameEl.addEventListener("focusin", enter);
    return () => {
      watch.disconnect();
      frameEl.removeEventListener("focusout", leave);
      frameEl.removeEventListener("focusin", enter);
    };
  }, [input.active, host]);
  useLayoutEffect(() => {
    const [entry, idle, critInRow] = JSON.parse(key) as [EntryStatus, string[], boolean];
    const probe = probeRef.current;
    const fit = input.active && probe && box ? measuredFit(probe, box) : FITS_ALL;
    const next = restStatus({ ...entry, idle, critInRow, fit });
    setMeasured((now) => (JSON.stringify(now) === JSON.stringify(next) ? now : next));
  }, [key, input.active, box]);
  const noteGone = measured.sentence?.place === "note" && (!input.entry.typed || (away !== null && away === measured.full));
  const status = noteGone ? { ...measured, sentence: null } : measured;
  const node = (
    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", ...(status.line.error ? { color: theme.color.dangerText } : null) }}>
      {status.line.text}
    </span>
  );
  /*
   * A box of no size that clips what it holds, so a long text measured in
   * it never widens what scrolls. It is drawn whenever the strip rests,
   * so it also carries what the status shows, wherever the header draws
   * it, for tests to read. Its text wraps as the title's and the note's
   * sentences do (SENTENCE_LINES), unclamped so its lines can be counted.
   */
  const probe = (
    <span
      ref={setHost}
      aria-hidden
      data-rest-status=""
      data-rest-line={status.line.text}
      data-rest-sentence={status.sentence?.text}
      data-rest-place={status.sentence?.place}
      style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, overflow: "hidden", visibility: "hidden", pointerEvents: "none" }}
    >
      <span ref={probeRef} style={{ ...SENTENCE_LINES, display: "block", WebkitLineClamp: "none", position: "absolute", left: 0, top: 0, fontSize: theme.font.small, fontWeight: theme.weight.regular }} />
    </span>
  );
  return { status, node, probe };
}

/** How many renders a focus moved to a strip's or an expanded bar's button waits for it to show. */
const FOCUS_TRIES = 3;

/**
 * How long the frame holds a clear request before it uses it: none, or
 * the page's `rvttClearWaitMs` where a run sets it. A test hook, so
 * e2e/barrest.e2e.ts can put a finger down on the map before the clearing
 * move, which Stage then cancels (3.6, review BB-OPUS-5). Nothing in the
 * app sets it.
 */
function clearWaitMs(): number {
  const hook = (globalThis as { rvttClearWaitMs?: unknown }).rvttClearWaitMs;
  return typeof hook === "number" && hook > 0 ? hook : 0;
}

/** Before the first measure: every text fits, so nothing is cut that may not need it. */
const FITS_ALL: RestFit = { line: () => true, title: () => true, note: () => true };

/**
 * Fits by the probe: one line against the line's drawn width, so a text
 * the browser would end in an ellipsis for under a pixel does not fit,
 * and the title's and the note's two lines by the probe's height at
 * their widths in the chrome's own px. A text wider than those widths
 * does not fit either, whatever its height, since the sentence would cut
 * what overflows.
 */
function measuredFit(probe: HTMLElement, box: StatusBox): RestFit {
  const measure = (text: string, width: number | null) => {
    probe.textContent = text;
    probe.style.whiteSpace = width === null ? "nowrap" : "normal";
    probe.style.width = width === null ? "auto" : `${width}px`;
    const drawn = probe.getBoundingClientRect().width;
    const lines = Math.round(probe.offsetHeight / STATUS_LINE_PX);
    const overflows = probe.scrollWidth > probe.clientWidth;
    probe.textContent = "";
    return { drawn, lines, overflows };
  };
  const twoLines = (text: string, width: number) => {
    const drawn = measure(text, width);
    return drawn.lines <= 2 && !drawn.overflows;
  };
  return {
    line: (text) => measure(text, null).drawn <= box.lineDrawn + 0.01,
    title: (text) => twoLines(text, box.line),
    note: (text) => twoLines(text, box.note),
  };
}

/**
 * Multi-select's press. Turning it on in an upright phone's expanded bar
 * also rests the bar, moving nothing (R3), so the map is free for the
 * taps that gather (docs/design-v1-bar-compact.md 5.3, D-261024-22).
 * Turning it off leaves the bar as it is. It reads the dock store's
 * `expanded`, not the state drawn, so a press in the scrolling strip a
 * roll card made of the expanded bar ends the state too, and the bar
 * rests once the card goes (review BB-OPUS-11). Drawn expanded, the body
 * the button stands in goes as the bar rests, so focus moves to Expand,
 * where Collapse leaves it. In the scrolling strip the button stays, and
 * so does focus.
 */
function useMultiToggle(rest: FrameControls["rest"], multi: boolean): { ref: RefObject<HTMLButtonElement | null>; toggle(): void } {
  const ui = useRoomUi();
  const ref = useRef<HTMLButtonElement>(null);
  const expanded = useStore(useScoped(barDockSlot), (s) => s.expanded);
  const toggle = () => {
    ui.setMultiSelect(!multi);
    if (multi || !rest || !expanded) return;
    const frame = ref.current?.closest<HTMLElement>('[role="dialog"]') ?? null;
    rest.collapse();
    if (rest.resting) return;
    // Found by its mark, since Expand in words carries no aria-label.
    requestAnimationFrame(() => frame?.querySelector<HTMLElement>("button[data-bar-size]")?.focus({ preventScroll: true }));
  };
  return { ref, toggle };
}

/**
 * Conditions and Uses from the strip (5.3): the bar expands with that
 * drawer open and focus on its button there, and closing the drawer by
 * its button rests the bar again, focus back on the strip's button.
 * Where Expand is not offered, the drawer opens inside the scrolling
 * strip instead. The drawer opened from the strip closes as the bar's
 * expanded state ends, by Collapse or by Multi-select turned on, and not
 * as a roll card turns the expanded bar into the scrolling strip with the
 * state kept (5.4). Closed there by either button, it ends the state
 * too, so the bar rests once the card goes (review BB-OPUS-4).
 */
function useRestDrawers(rest: FrameControls["rest"], drawer: Drawer, setDrawer: (d: Drawer) => void) {
  const [opened, setOpened] = useState<Drawer>(null);
  const [focus, setFocus] = useState<{ place: "rest" | "play"; id: string; tries: number } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const resting = rest?.resting === true;
  const expanded = useStore(useScoped(barDockSlot), (s) => s.expanded);
  const wasExpanded = useRef(expanded);
  useLayoutEffect(() => {
    const collapsed = wasExpanded.current && !expanded;
    wasExpanded.current = expanded;
    if (collapsed && opened !== null) {
      setDrawer(null);
      setOpened(null);
    }
  }, [expanded, opened, setDrawer]);
  /*
   * The strip's button may draw a render late: its row fits the candidates
   * the bar just gave it before it shows them. So the focus waits a few
   * renders for its button to take it, and then gives up, never to steal
   * focus later.
   */
  useLayoutEffect(() => {
    if (!focus || (focus.place === "rest") !== resting) return;
    const button = buttons.current.get(`${focus.place}:${focus.id}`);
    button?.focus();
    if (button && button.ownerDocument.activeElement === button) setFocus(null);
    else setFocus(focus.tries >= FOCUS_TRIES ? null : { ...focus, tries: focus.tries + 1 });
  });
  const close = () => {
    setDrawer(null);
    if (opened !== null && rest && expanded) {
      setFocus({ place: "rest", id: opened, tries: 0 });
      setOpened(null);
      rest.collapse();
    }
  };
  return {
    ref: (place: "rest" | "play", id: string) => (el: HTMLButtonElement | null) => {
      if (el) buttons.current.set(`${place}:${id}`, el);
      else buttons.current.delete(`${place}:${id}`);
    },
    fromRest(id: "conditions" | "uses") {
      if (!rest || rest.scrolls) {
        if (drawer === id) close();
        else setDrawer(id);
        return;
      }
      setDrawer(id);
      setOpened(id);
      setFocus({ place: "play", id, tries: 0 });
      rest.expand();
    },
    toggle(id: "conditions" | "uses") {
      if (drawer === id) close();
      else {
        setDrawer(id);
        setOpened(null);
      }
    },
    close,
  };
}
