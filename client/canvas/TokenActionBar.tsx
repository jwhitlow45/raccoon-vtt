import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject } from "react";
import { useStore } from "zustand";
import { healRevivesDead } from "#shared/migrate.ts";
import { CONDITION_KEYS, STATUS_KEYS, type Actor, type Effect, type Token } from "#shared/model.ts";
import { hpLess, shownLife } from "#shared/rules/hp.ts";
import { oneSize } from "#shared/rules/path.ts";
import type { ClientOp } from "#shared/protocol.ts";
import { Button } from "../components/Button.tsx";
import { RETURN_RANK, useSheetReturnFocus } from "../components/sheetFocus.ts";
import { Icon } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { GRIP_ATTR, PaneHeader, STICKY_HEADER_ATTR, type PaneHandle } from "../components/SheetHeader.tsx";
import { useLayoutSize } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { usePreview } from "../features/dm/previewContext.ts";
import { useSend } from "../features/encounter/hooks.ts";
import { tokenAccess } from "../features/tokens/access.ts";
import { AltImagesRow } from "../features/tokens/AltImages.tsx";
import { DoorButton } from "../features/doors/DoorButton.tsx";
import { GroundNotice } from "../features/movement/GroundNotice.tsx";
import { LightChip } from "../features/vision/LightChip.tsx";
import { offersRequest } from "../features/rolls/logic.ts";
import { openAsk } from "../features/rolls/open.ts";
import { EffectIcon } from "../features/tokens/EffectIcon.tsx";
import { duplicateToken, occupiedBoxes, spreadPositions } from "../features/tokens/factory.ts";
import { DefenseLines, MoreStats, SavesLine, SheetAnchor, useLinkedBlock, VitalsLine } from "../features/tokens/StatSummary.tsx";
import { openStatBlock } from "../features/tokens/statBlockOpen.ts";
import { shortSplit, validSheetUrl, vitals } from "../features/tokens/statSummary.ts";
import { statBlockShown, tokenStatBlock } from "../features/monsters/statBlockLink.ts";
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
  updateManyOps,
  type Lit,
} from "../features/tokens/groupEdit.ts";
import { deadHealLine } from "../features/tokens/groupHp.ts";
import { GroupHpEntry } from "../features/tokens/GroupHpEntry.tsx";
import { GroupMoreSheet } from "../features/tokens/GroupMoreSheet.tsx";
import { DeathSaves, HpEntry, oneTarget } from "../features/tokens/HpSection.tsx";
import { pathNow } from "../features/measure/movement.ts";
import { customWords, SIZE_WORDS, stepSize } from "../features/tokens/resize.ts";
import { useResize } from "../features/tokens/useResize.ts";
import { REVIVE_NOTE, ReviveButton, offersRevive } from "../features/tokens/Revive.tsx";
import { lastMoveSlot, offered, offersMarkUndo, offersUndo, undoOf } from "../features/tokens/undoMove.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
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
  DEFAULT_SPOT,
  handleCorner,
  hangBox,
  hasSize,
  headerBand,
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
  sizeWords,
  spotWords,
  writeSize,
  writeSpot,
  type BarFacts,
  type BarSize,
  type Box,
  type Corner,
  type ResizeLimits,
  type ResizePart,
  type Spot,
} from "./barDock.ts";
import { barButtons, barShort, isCompanion, type BarButtonId } from "./barButtons.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";

const NO_CHARACTERS = {};

/** A row of the bar's buttons, wrapping. An empty one takes no room (globals.css). */
const BUTTON_ROW = { display: "flex", flexWrap: "wrap", gap: theme.space(1) } as const;

type Drawer = "conditions" | null;

/**
 * Where focus goes once Revive leaves the bar: its frame, which announces
 * the bar, as the dock's Show does. The HP field would take Ctrl+Z from the
 * room's undo, which takes the Revive back, and open a phone's keyboard.
 */
const REVIVE_FOCUS_IN_BAR = { scope: '[role="dialog"]', to: [":scope"] } as const;

/**
 * The bar that opens under a tapped token (design section 14.3), in the
 * order docs/design-v1-token-panel.md 3.3 ranks by use: the header, the
 * stat summary's vitals (AC, HP, speed, Passive Perception), the HP entry
 * right after them, death saves, the effects, a linked block's saves and
 * defenses, then "Stat block", the sheet link and Details beside the
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
}) {
  const { token } = props;
  return (
    <BarFrame
      anchor={props.anchor}
      viewport={props.viewport}
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
  const store = useRoomStore();
  const you = useRoomView((s) => s.you);
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const playersApplyDamage = useRoomView((s) => s.view?.meta.settings.playersApplyDamage ?? false);
  const scene = useRoomView((s) => s.view?.scenes[token.sceneId]);
  const tokens = useRoomView((s) => s.view?.tokens);
  const multi = useRoomView((s) => s.local.multi);
  const encounter = useRoomView((s) => s.view?.encounter);
  const monsters = useRoomView((s) => s.view?.monsters);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const scope = useRoomScope();
  // Only a creature a player plays, askable where it stands, offers a roll request (docs/design-v1-dm-tools.md 3.3, rolls/logic.ts askTarget).
  const played = useRoomView((s) => (s.view ? offersRequest(s.view, [token]) : false));
  const undoOffer = useStore(useScoped(lastMoveSlot), offered);

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
  const block = useLinkedBlock(token, actor, access);
  const link = tokenStatBlock(actor, monsters);
  const statBlock = statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor }) && (link.kind === "room" || link.kind === "srd");
  const sheetUrl = actor?.sheetUrl ? validSheetUrl(actor.sheetUrl) : null;
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

  const path = pathNow(encounter, token, you?.role ?? "player");
  const rows = barButtons({
    dm: access.dm,
    owner: access.owner,
    undoMove: offersUndo(undoOffer, [token.id]),
    movedThisTurn: path !== null && path.stops.length >= 2,
    // A player's own token: the door button finds the nearest door in reach itself, and shows nothing without one.
    door: true,
    light: (scene !== undefined && visionOn(scene)) || (token.light !== undefined && (token.light.bright > 0 || token.light.dim > 0)),
    played,
    companion: isCompanion(token),
  });
  const button = (id: BarButtonId): ReactNode => {
    switch (id) {
      case "undoMove":
        return <UndoMoveButton key={id} tokenIds={[token.id]} />;
      case "countLeg":
        return <CountLegButton key={id} token={token} />;
      case "door":
        return <DoorButton key={id} token={token} />;
      case "conditions":
        return (
          <BarButton key={id} pressed={drawer === "conditions"} onClick={() => setDrawer((d) => (d === "conditions" ? null : "conditions"))}>
            Conditions
          </BarButton>
        );
      case "requestRoll":
        return (
          <BarButton key={id} onClick={() => openAsk(scope, { kind: "selection", tokenIds: [token.id] })}>
            Request a roll
          </BarButton>
        );
      // Toggles named for the state they are in, lit while it holds, so a lit button never reads as the opposite.
      case "hidden":
        return (
          <BarButton
            key={id}
            pressed={token.visibility === "dm"}
            onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { visibility: token.visibility === "dm" ? "all" : "dm" } })}
          >
            Hidden
          </BarButton>
        );
      case "light":
        return <LightChip key={id} token={token} />;
      case "multiSelect":
        return (
          <BarButton key={id} pressed={multi} onClick={() => ui.setMultiSelect(!multi)}>
            Multi-select
          </BarButton>
        );
      case "locked":
        return (
          <BarButton key={id} pressed={token.locked} onClick={() => actions.dispatch({ t: "token.update", tokenId: token.id, patch: { locked: !token.locked } })}>
            Locked
          </BarButton>
        );
      case "duplicate":
        return (
          <BarButton key={id} onClick={duplicate}>
            Duplicate
          </BarButton>
        );
      case "delete":
        return (
          <DeleteButton
            key={id}
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

  const savesAndDefenses = short ? (
    <MoreStats more={split.more} block={block} />
  ) : (
    <>
      <SavesLine block={block} />
      <DefenseLines block={block} clamp />
    </>
  );

  return (
    <>
      <BarHeader
        // Two lines of the name at most: the frame's name holds all of it, and the token's plate shows it on the map.
        title={displayName(token)}
        actions={badge ? <span style={{ flex: "none", color: theme.color.accentSoft, fontWeight: theme.weight.bold }}>{badge} ft</span> : null}
        onClose={props.onClose}
      />
      <VitalsLine items={short ? split.line : items} afterTag={revive ? <ReviveButton target={target} describedBy={deadLineId} focusTo={REVIVE_FOCUS_IN_BAR} /> : undefined} />
      {deadLine ? (
        <div id={deadLineId} style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>
          {deadLine}
        </div>
      ) : null}

      {access.hp !== "none" && !noHp ? (
        <HpEntry
          targets={[oneTarget(target, access.hp, atZero, { name: displayName(token), dead: life === "dead", max: actor?.hp?.max })]}
          access={access.hp}
          place="bar"
          fieldFirst={short}
        />
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

      {savesAndDefenses}

      {/* Stat block and Details both open the panel, so they sit with the summary they expand. */}
      <div role="group" aria-label="Read more" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
        {statBlock ? <BarButton onClick={() => openStatBlock(scope, ui, token.id)}>Stat block</BarButton> : null}
        {sheetUrl ? <SheetAnchor url={sheetUrl} /> : null}
        <BarButton onClick={props.onDetails}>Details</BarButton>
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

      {/* With the rows that change how the map draws the creature: how high, how big, which picture (docs/design-v1-token-window.md 8.9). */}
      {access.dm || (access.owner && !token.locked) ? <SizeRow token={token} owner={access.owner} canResize={access.resize} /> : null}

      {access.canEditToken("altImages") ? (
        <AltImagesRow
          token={token}
          aspect={footprint(token).w / footprint(token).h}
          onPatch={(patch) => actions.dispatch({ t: "token.update", tokenId: token.id, patch })}
        />
      ) : null}

      {drawer === "conditions" ? <QuickConditions lit={(key) => (effects.some((e) => e.key === key) ? "all" : "none")} onToggle={toggleEffect} /> : null}

      {rows.passing.length > 0 ? (
        <div data-bar-row="passing" style={BUTTON_ROW}>
          {rows.passing.map(button)}
        </div>
      ) : null}
      <div data-bar-row="play" style={BUTTON_ROW}>
        {rows.play.map(button)}
      </div>
      {rows.less.length > 0 ? (
        <div data-bar-row="less" style={BUTTON_ROW}>
          {rows.less.map(button)}
        </div>
      ) : null}
    </>
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
  viewport: Size;
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
      viewport={props.viewport}
      label={`${tokens.length} selected tokens`}
      dock={{ text: `${tokens.length} selected`, show: `Show actions for ${tokens.length} selected tokens`, closeLabel: "Let go of all of them", close: props.onClose }}
    >
      <BarHeader title={`${tokens.length} selected`} onClose={props.onClose} closeLabel="Let go of all of them" />
      <div style={{ color: theme.color.textMuted, overflowWrap: "anywhere" }}>{tokens.map((t) => displayName(t)).join(", ")}</div>
      <GroupBarHp tokens={tokens} />
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
      <div data-bar-row="passing" style={BUTTON_ROW}>
        <UndoMoveButton tokenIds={ids} />
      </div>
      <div data-bar-row="play" style={BUTTON_ROW}>
        {offers.conditions ? (
          <BarButton pressed={drawer === "conditions"} onClick={() => setDrawer((d) => (d === "conditions" ? null : "conditions"))}>
            Conditions
          </BarButton>
        ) : null}
        {offers.dm ? (
          <BarButton pressed={hidden === "all"} half={hidden === "some"} onClick={() => send(updateManyOps(ids, flagPatch(tokens, "hidden")))}>
            Hidden
          </BarButton>
        ) : null}
        <BarButton pressed={multi} onClick={() => ui.setMultiSelect(!multi)}>
          Multi-select
        </BarButton>
        {offers.dm && anyPlayed ? <BarButton onClick={() => openAsk(scope, { kind: "selection", tokenIds: ids })}>Request a roll</BarButton> : null}
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
        <BarButton onClick={props.onClose}>Clear</BarButton>
      </div>
      {more ? <GroupMoreSheet tokens={tokens} opener={moreButton} onClose={() => setMore(false)} /> : null}
    </BarFrame>
  );
}

/** The group's HP entry, field and Apply first while the window is short, as the frame decides (5.8). */
function GroupBarHp(props: { tokens: readonly ViewToken[] }) {
  const frame = useContext(FrameContext);
  return <GroupHpEntry tokens={props.tokens} place="bar" fieldFirst={frame.short} />;
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
    <BarButton onClick={() => actions.dispatch(undoOf(offer))}>Undo move</BarButton>
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
  // A resize's leg is no move, so it has nothing to stop counting (docs/design-v1-token-window.md 8.7).
  if (!last || !before || !oneSize(before, last)) return null;
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
 * What a bar's frame hands its header and its rows: the header's handle,
 * with its grip, and stickiness, Reset while the window docks away from
 * its default (docs/design-v1-token-window.md 4.4), the header's band
 * (7.1), and whether the bar is short.
 */
type FrameControls = {
  handle: PaneHandle | null;
  sticky: boolean;
  place: { moved: boolean; reset(): void; closeRef: RefObject<HTMLButtonElement | null>; onResetFocus(focused: boolean): void } | null;
  /** A window narrower than one header row stacks its header (barDock.ts headerBand). */
  stacked: boolean;
  /** The bar has under 300 px where it stands (barButtons.ts barShort), whatever its content. */
  short: boolean;
};

const FrameContext = createContext<FrameControls>({ handle: null, sticky: false, place: null, stacked: false, short: false });

/** Reset's name and tooltip, on every device. */
const RESET_LABEL = "Reset window position and size";

/**
 * The bar's header: the grip while it docks, its name on at most two
 * lines, the elevation badge, Reset while the window is away from its
 * default, and Close. Sticky while it docks or spans.
 */
function BarHeader(props: { title: string; actions?: ReactNode; onClose(): void; closeLabel?: string }) {
  const frame = useContext(FrameContext);
  const { place } = frame;
  const reset = place?.moved ? (
    <IconButton icon="windowHome" label={RESET_LABEL} onClick={place.reset} onFocus={() => place.onResetFocus(true)} onBlur={() => place.onResetFocus(false)} />
  ) : null;
  return (
    <PaneHeader
      title={props.title}
      actions={props.actions}
      beforeClose={reset}
      onClose={props.onClose}
      closeLabel={props.closeLabel}
      closeRef={place?.closeRef}
      handle={frame.handle ?? undefined}
      sticky={frame.sticky}
      stacked={frame.stacked}
      lines={2}
    />
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
 * phone held upright spans the screen under or over its token, as before.
 * A screen too short for either opens it compact: a taller overlay over
 * the Multi-select bar, and over the toolbar when even that is short,
 * which scrolls as a whole and does not move. In each, a bar that meets
 * the fight alerts column across shares the right lane with it
 * (barDock.ts shareLane), and once it is drawn it publishes its box for
 * the column, the notices and the camera.
 *
 * It scrolls inside when its content outgrows its room, with a "Scroll
 * for more" fade at the bottom while anything is hidden, so Duplicate or
 * Delete never sit out of view without a hint. While it docks or spans
 * its header sticks to the top, so the handle and Close never scroll away.
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
  // Beside a sideways sheet that leaves it too little room for its header, the window folds into the sheet's header (docs/design-v1-token-window.md 7.1).
  const folded = foldsUnderSheet({ ...layout, sheetOpen: anySheet, full, sideRoom: sideSheetRoom(props.viewport, chrome) });
  const spot = useStore(dockStore, (s) => s.spot);
  const size = useStore(dockStore, (s) => s.size);
  const finePointer = useStore(dockStore, (s) => s.finePointer);
  const width = useStore(dockStore, (s) => s.defaultWidth);
  const column = useStore(dockStore, (s) => s.column);
  const foot = useStore(dockStore, (s) => s.foot);
  const barRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [barHeight, setBarHeight] = useState(() => dockStore.getState().lastHeight);
  const [clipped, setClipped] = useState(false);
  const [pad, setPad] = useState({ top: 0, bottom: 0 });
  const [status, setStatus] = useState("");
  const statusSeq = useRef(0);
  const handleDescription = useId();
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
    if (dockStore.getState().lastHeight !== height) dockStore.setState({ lastHeight: height });
    const cut = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 4;
    setClipped(cut);
    const header = content.querySelector<HTMLElement>(`[${STICKY_HEADER_ATTR}]`);
    // The fade is the scroller's last child, a zero-height row whose one child is the drawn fade.
    const fade = cut ? (scroller.lastElementChild?.firstElementChild as HTMLElement | null | undefined) : null;
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
  // The fade's height, once it shows.
  useLayoutEffect(measure, [clipped]);

  // The anchor is always given here, so a placement always comes back.
  const placed = placeBar({ layout, viewport: props.viewport, chrome, foot, anchor: props.anchor, spot, height: barHeight, column, width, size, resizable: finePointer })!;
  const { free, mode, resizable } = placed;

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
  const facts: BarFacts | null = folded ? null : { box: hangBox(placed.hang, barHeight), mode, lane: placed.lane, laneLeft: laneLeft(free), freeRight: free.left + free.width };
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
  const short = barShort({ layout, viewport: props.viewport, chrome, foot, anchor: props.anchor, spot, column, width, size, resizable: finePointer });
  const stacked = mode === "dock" && headerBand(placed.hang.width) !== "row";
  const controls: FrameControls = { handle, sticky: mode !== "compact", place, stacked, short };

  const { hang } = placed;
  const where = dragBox
    ? { left: dragBox.left, top: dragBox.top, width: dragBox.width, maxHeight: dragBox.height }
    : hang.anchor === "top"
      ? { left: hang.left, top: hang.at, width: hang.width, maxHeight: hang.room }
      : { left: hang.left, bottom: props.viewport.height - hang.at, width: hang.width, maxHeight: hang.room };
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
  return (
    <div
      ref={barRef}
      role="dialog"
      aria-label={props.label}
      hidden={folded}
      data-bar-mode={mode}
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
        zIndex: mode === "compact" ? theme.z.barOverlay : theme.z.pane,
      }}
    >
      <div
        ref={scrollRef}
        data-bar-scroll=""
        onScroll={measure}
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
              padding: `${theme.space(1)}px ${theme.space(3)}px ${theme.space(3)}px`,
              display: "grid",
              // One column no wider than the bar: an auto column grows to its widest unbreakable child, such as a long name, and pushes the buttons out of view.
              gridTemplateColumns: "minmax(0, 1fr)",
              gap: theme.space(2),
            }}
          >
            {props.children}
          </div>
        </FrameContext.Provider>
        {clipped ? <ScrollForMore /> : null}
      </div>
      {resizable && !folded ? (
        <>
          <div aria-hidden data-resize-band="" {...resizeHandlers("height")} style={bandStyle(handleAt, "height")} />
          <div aria-hidden data-resize-band="" {...resizeHandlers("width")} style={bandStyle(handleAt, "width")} />
          <button
            type="button"
            aria-label="Resize window"
            title="Resize window"
            aria-describedby={handleDescription}
            data-resize-handle=""
            {...resizeHandlers("corner")}
            onKeyDown={resizeByKeys}
            style={handleStyle(handleAt, dragBox !== null)}
          >
            <Icon name="resize" size={16} style={handleAt === "tr" || handleAt === "bl" ? { transform: "rotate(90deg)" } : undefined} />
          </button>
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
 * "Scroll for more", laid over the foot of a box that scrolls while
 * anything is hidden below. It has no height of its own, so it never adds
 * to what scrolls, and screen readers skip it: they reach every control by
 * moving through them. The alerts column shows it too while a docked bar
 * cuts it short (features/encounter/InitiativeStrip.tsx), and a popover
 * (components/Popover.tsx). Its fade ends in `surface`, the color of the
 * boxes it covers. As wide as its box, so in a row that wraps it takes a
 * line of its own.
 */
export function ScrollForMore() {
  return (
    <div aria-hidden style={{ position: "sticky", bottom: 0, width: "100%", height: 0, pointerEvents: "none" }}>
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
 */
function DismissButton(props: { tokenId: string; name: string }) {
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
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        send({ t: "token.delete", tokenId: props.tokenId });
      }}
      style={{ flex: "none" }}
    >
      {text}
    </Button>
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
      <BarButton ref={smaller} label="One size smaller" disabled={down === null} onClick={() => down && press(down, -1)}>
        −
      </BarButton>
      <span style={{ display: "inline-grid", textAlign: "center", fontWeight: theme.weight.bold }}>
        <span aria-hidden style={{ gridArea: "1 / 1", visibility: "hidden" }}>
          Gargantuan
        </span>
        <span aria-live="polite" style={{ gridArea: "1 / 1" }}>
          {SIZE_WORDS[token.size]}
        </span>
      </span>
      <BarButton ref={larger} label="One size larger" disabled={up === null} onClick={() => up && press(up, 1)}>
        +
      </BarButton>
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
      <div style={{ flex: "none", marginLeft: "auto", display: "flex", alignItems: "center", gap: theme.space(1) }}>{props.children}</div>
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
  children: ReactNode;
  label?: string;
  pressed?: boolean;
  half?: boolean;
  danger?: boolean;
  armed?: boolean;
  grow?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      ref={props.ref}
      size="sm"
      variant={props.danger ? "danger" : "secondary"}
      disabled={props.disabled}
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
