import type { IconName } from "../components/Icon.tsx";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import type { Actor, Character, CreatureSize, HpVisibility, Token, TokenKind } from "#shared/model.ts";
import type { ActorPatch, ClientOp, TokenPatch } from "#shared/protocol.ts";
import { hpLess } from "#shared/rules/hp.ts";
import type { NextSize } from "#shared/rules/resize.ts";
import { isCompanion } from "../canvas/barButtons.ts";
import { DismissButton } from "../canvas/TokenActionBar.tsx";
import { AttachButton } from "../features/attach/AttachButton.tsx";
import { DetachButton, DetachNote, GroupLine, useAttachSlots, useDetach, type AttachFocus } from "../features/attach/BarParts.tsx";
import { attachControls } from "../features/attach/detach.ts";
import { SteerControl, usePanelLinkTags } from "../features/attach/SteerControl.tsx";
import { useUsesPresence } from "../features/combat/CombatUses.tsx";
import { UsesSection } from "../features/combat/UsesSection.tsx";
import { ReactionSection, reactionFor } from "../features/encounter/ReactionSection.tsx";
import { Button } from "../components/Button.tsx";
import { Checkbox } from "../components/Checkbox.tsx";
import { Empty } from "../components/Empty.tsx";
import { Group } from "../components/Panel.tsx";
import { QuickStartLink } from "../features/guide/GuideLink.tsx";
import { RowDot } from "../components/Row.tsx";
import { Switch } from "../components/Switch.tsx";
import { usePreview } from "../features/dm/previewContext.ts";
import { usePanelHere, type PanelProps } from "../features/panels.ts";
import { ImageField } from "../features/images/ImageField.tsx";
import { RangeRingsSection } from "../features/measure/RangeRingsSection.tsx";
import { statBlockShown } from "../features/monsters/statBlockLink.ts";
import { GroundNotice } from "../features/movement/GroundNotice.tsx";
import { ownsCharacter, tokenAccess, tokenOwnerIds, type TokenAccess } from "../features/tokens/access.ts";
import { useAltImages } from "../features/tokens/AltImages.tsx";
import { CompanionOwners, CompanionSection, MakeCompanion, followsPartyHp } from "../features/tokens/CompanionsSection.tsx";
import { characterPageSlot, openCharacterPage } from "../features/tokens/characterPage.ts";
import { CREATURE_HEADING, CreatureHeader, type HeaderTag } from "../features/tokens/CreatureHeader.tsx";
import { kindLine, sizeText, tokenKind } from "../features/tokens/creatureKind.ts";
import { EffectsSection } from "../features/tokens/EffectsSection.tsx";
import { shownRowOps } from "../features/tokens/groupEdit.ts";
import { HpSection } from "../features/tokens/HpSection.tsx";
import { relationKey, usePanelFolds, type FoldKey } from "../features/tokens/panelFolds.ts";
import { combatSummary, holdsClassResources, offersMakeCompanion, panelGroups, panelRelation, reactionSpent, type PanelGroupId, type PanelSectionId } from "../features/tokens/panelOrder.ts";
import { backTo, baseSize, customWords, SIZE_WORDS } from "../features/tokens/resize.ts";
import { RestSection } from "../features/tokens/RestSection.tsx";
import { StatBlockSection } from "../features/tokens/StatBlockSection.tsx";
import { CardNotesField, SheetUrlField, StatsFields } from "../features/tokens/StatsSection.tsx";
import { useSrdList } from "../features/tokens/StatSummary.tsx";
import { useDuplicate, type DuplicateFocus } from "../features/tokens/useDuplicate.ts";
import { useResize } from "../features/tokens/useResize.ts";
import { hpUnits, unitText, vitals } from "../features/tokens/statSummary.ts";
import { QuickNumbers } from "../features/tokens/QuickNumbers.tsx";
import { TokenNotes } from "../features/tokens/TokenNotes.tsx";
import { TokenSight } from "../features/vision/TokenSight.tsx";
import { ConfirmButton, FieldRow, Note, NumberField, Section, Select, Stepper, TextField } from "../features/tokens/ui.tsx";
import { displayName, footprint } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { DISPOSITION_RING, elevationBadge, initials } from "../lib/tokenView.ts";
import { dispatchGesture } from "../state/actions.ts";
import { useRoomScope } from "../state/scope.ts";
import { handFocusWhenFound } from "../lib/handFocus.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";

const SIZE_OPTIONS: { value: CreatureSize; label: string }[] = [
  { value: "tiny", label: "Tiny" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "huge", label: "Huge" },
  { value: "gargantuan", label: "Gargantuan" },
  { value: "custom", label: "Custom" },
];

const KIND_OPTIONS: { value: TokenKind; label: string }[] = [
  { value: "pc", label: "Player character" },
  { value: "npc", label: "NPC" },
  { value: "monster", label: "Monster" },
  { value: "object", label: "Object or marker" },
];

const HP_VISIBILITY_OPTIONS: { value: HpVisibility; label: string }[] = [
  { value: "hidden", label: "Nothing" },
  { value: "label", label: "Healthy, Bloodied, Dying, Dead" },
  { value: "bar", label: "A bar" },
  { value: "exact", label: "Exact numbers" },
];

/**
 * The selected token's panel (features sections 5, 7, 8 and 15), grouped
 * by use (docs/design-v1-token-panel-groups.md, panelOrder.ts): the name
 * with its picture and quick numbers, the stat block, then the Combat,
 * Notes, Position and Image groups, and the setup groups folded at the
 * foot, each as this device last left it (panelFolds.ts). The DM and the token's owners, directly or through its
 * character, get its full stat card and the controls their role allows.
 * Everyone else sees the public view: the name the projection gave them,
 * the HP the DM allows, conditions with their rules text, and the
 * elevation.
 */
export default function TokenPanel(props: PanelProps) {
  // One instance per token, so an armed Delete or a half-typed field never carries over to the next token selected.
  // The box around it stays, so a press that selects another token hands focus on inside it (PANEL_BOX).
  return (
    <div data-token-panel="">
      <TokenDetails key={props.selectedTokenId ?? ""} {...props} />
    </div>
  );
}

/** The panel's own box, which stays while the panel remounts for another token. */
const PANEL_BOX = "[data-token-panel]";

/** Position's attach controls, for a press there that takes its button away to find the nearest one that stays. */
const ATTACH_CONTROLS = "[data-attach-controls]";

/**
 * Where focus goes once Let go, Put down or Get off took its button away
 * (D-261024-42): the attach controls that stay, else the name heading.
 */
const ATTACH_FOCUS: AttachFocus = { scope: PANEL_BOX, to: [`${ATTACH_CONTROLS} button`, CREATURE_HEADING] };

/**
 * A press that selects another token remounts the panel for it, so focus
 * goes to that creature's name, read first: Duplicate's copy, and a name in
 * Position's group line (docs/design-v1-token-sections.md 7, D-261024-47).
 */
const TO_NAME: AttachFocus & DuplicateFocus = { scope: PANEL_BOX, to: [CREATURE_HEADING] };

/** The empty panel's line, which takes focus from script when what had it went with its token. */
const EMPTY_LINE = "[data-token-empty]";


function TokenDetails(props: PanelProps) {
  const tokenId = props.selectedTokenId;
  const token = useRoomView((s) => (tokenId ? s.view?.tokens[tokenId] : undefined));
  const you = useRoomView((s) => s.you);
  const character = useRoomView((s) => (token && "ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const playersApplyDamage = useRoomView((s) => s.view?.meta.settings.playersApplyDamage ?? false);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const actions = useRoomActions();
  const { folds, slot } = usePanelFolds();
  const preview = usePreview() !== null;

  const access = useMemo(
    () =>
      token && you
        ? tokenAccess({
            role: you.role,
            memberId: you.memberId,
            view: { characters: character ? { [character.id]: character } : {}, meta: { settings: { playersApplyDamage } } },
            token,
          })
        : null,
    [token, you, character, playersApplyDamage],
  );
  const self = useMemo(() => (tokenId ? { tokenId } : null), [tokenId]);
  // Its uses, for the DM on any creature with one and for owners on theirs, as the bar's Uses button reads them.
  const usesPresence = useUsesPresence(access?.full ? self : null);
  // Each a yes or no, so the panel draws again only when one changes, not on every change to the room.
  const reaction = useRoomView((s) => (self && s.view ? reactionFor(s.view, s.you, self) !== null : false));
  const spent = useRoomView((s) => (self && s.view ? reactionSpent(s.view, self) : false));
  const attach = useRoomView((s) => {
    const t = tokenId ? s.view?.tokens[tokenId] : undefined;
    return t && s.view ? attachControls(s.view, { role: s.you?.role ?? "player", memberId: s.you?.memberId ?? null }, t) : false;
  });

  if (!token || !access)
    return (
      <Empty action={you?.role === "dm" ? <QuickStartLink /> : undefined}>
        {/* Focusable from script, not by Tab, for a press that took the panel's token away (DismissSection). */}
        <span tabIndex={-1} data-token-empty="">
          Tap a token to see it here.
        </span>
      </Empty>
    );

  const actor: Partial<Actor> | undefined = "inline" in token.actor ? token.actor.inline : character?.actor;
  const fp = footprint(token);
  const name = displayName(token);
  const update = (patch: TokenPatch) => actions.dispatch({ t: "token.update", tokenId: token.id, patch });
  const patchActor = (patch: ActorPatch) => {
    if (access.actorVia === "character" && character) actions.dispatch({ t: "character.update", characterId: character.id, patch: { actor: patch } });
    else update({ actor: patch });
  };
  // A viewer's tap is what this device remembers. "View as a player" reads what is stored and never writes it.
  const groupFold = (key: FoldKey) => ({ open: folds[key], onToggle: () => slot.tap(key, !folds[key], !preview) });
  const companion = isCompanion(token);
  // The quick numbers stand under the name (docs/design-v1-dice-ui.md 5.1).
  const quickNumbers = vitals({ actor, token, fullAccess: access.full, place: "panel" });
  // A player lent only a token of a character holds none of its card (docs/design-v1-pc-stats.md 4.2), so it has no stat card to show or edit there.
  const playsCharacter = character !== undefined && ownsCharacter(you?.memberId, character);
  const cardNotes =
    access.full && actor && (access.canEditActor("notes") || actor.notes !== undefined) ? (
      <CardNotesField actor={actor} editable={access.canEditActor("notes")} onPatch={patchActor} label="Card notes" rows={2} />
    ) : null;
  const statCard = actor !== undefined && (character === undefined || access.dm || playsCharacter);
  const classResources = holdsClassResources({ dm: access.dm, character: character !== undefined, playsCharacter });
  const parts = panelGroups({
    dm: access.dm,
    owner: access.owner,
    kind: token.kind,
    companion,
    statBlockShown: statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor, companion, character: "ref" in token.actor, ownsCharacter: character ? playsCharacter : undefined }),
    actor: statCard,
    ownerRenames: !access.dm && access.canEditToken("name"),
    classResources,
    uses: usesPresence,
    reaction,
    attach,
    locked: token.locked,
    dismiss: access.dismiss,
    notes: access.canEditToken("notes") || !!token.notes || access.dm || cardNotes !== null,
    image: access.canEditToken("image"),
  });
  const relation = panelRelation(access);

  const section = (id: PanelSectionId): ReactNode => {
    switch (id) {
      case "name":
        return (
          <NameBlock key={id} token={token} name={name} actor={actor} character={character} feetPerCell={feetPerCell}>
            <QuickNumbers items={quickNumbers} actor={actor} token={token} />
          </NameBlock>
        );
      case "image":
        return <ImageRow key={id} token={token} name={name} access={access} update={update} />;
      case "statBlock":
        return <StatBlockSection key={id} token={token} actor={actor} access={access} patchActor={patchActor} />;
      case "hp":
        return <HpSection key={id} actor={actor} hpVisibility={token.hpVisibility} target={{ tokenId: token.id }} access={access} name={name} token={token} />;
      case "conditions":
        return <EffectsSection key={id} effects={actor?.effects ?? []} target={{ tokenId: token.id }} self={{ tokenId: token.id }} selfLabel={name} canEdit={access.effects} />;
      case "uses":
        return <UsesSection key={id} target={{ tokenId: token.id }} name={name} character={classResources ? character : undefined} />;
      case "reaction":
        return <ReactionSection key={id} self={{ tokenId: token.id }} name={name} />;
      case "position":
        return <PositionSection key={id} token={token} access={access} update={update} />;
      case "attach":
        return <AttachControls key={id} token={token} />;
      case "rangeRings":
        return <RangeRingsSection key={id} token={token} canEdit={access.canEditToken("rangeRings")} update={update} />;
      case "notes":
        return (
          <TokenNotes
            key={id}
            notes={token.notes}
            canEdit={access.canEditToken("notes")}
            onNotes={(notes) => update({ notes })}
            card={cardNotes}
            dm={access.dm && actor ? { notes: actor.dmNotes ?? "", onNotes: (dmNotes) => patchActor({ dmNotes }) } : null}
          />
        );
      case "rest":
        return <RestSection key={id} actor={actor?.hp && actor.life ? { hp: actor.hp, life: actor.life } : undefined} target={{ tokenId: token.id }} resources={character?.resources} />;
      case "sight":
        return <TokenSight key={id} token={token} actor={actor} access={access} update={update} />;
      case "stats":
        // A player lent only a character's token holds no card, so its Stats is the bar's Size alone (docs/design-v1-token-sections.md 3).
        return statCard && actor ? (
          <Group key={id} label="Stats" icon="stats" {...groupFold("stats")}>
            <SizeField token={token} actor={actor} access={access} feetPerCell={feetPerCell} />
            <StatsFields actor={actor} canEdit={access.canEditActor} onPatch={patchActor} dm={access.dm} noAc={hpLess(actor, token)} fromBlock={character?.stats !== undefined} />
            {access.canEditActor("sheetUrl") ? (
              <FieldRow label="Sheet link" fill>
                <SheetUrlField value={actor.sheetUrl ?? ""} onPatch={patchActor} />
              </FieldRow>
            ) : null}
          </Group>
        ) : (
          <Group key={id} label="Stats" icon="stats" {...groupFold("stats")}>
            <SizeField token={token} actor={actor ?? {}} access={access} feetPerCell={feetPerCell} />
          </Group>
        );
      case "settings":
        return (
          <Group key={id} label="Token settings" icon="settings" {...groupFold("settings")}>
            {access.dm ? <DmSettings token={token} feetPerCell={feetPerCell} update={update} /> : <OwnerNames token={token} access={access} update={update} />}
          </Group>
        );
      // docs/design-v1-combat-flow.md 3.6.9's section, a group folded through this panel's folds with its character beside its name.
      case "companion":
        return <CompanionSection key={id} token={token} access={access} group={groupFold("companion")} />;
      case "owners":
        return <Owners key={id} token={token} update={update} group={groupFold("owners")} />;
      case "remove":
        return access.dm ? (
          <DmActions key={id} token={token} onDeleted={props.close} />
        ) : (
          <DismissSection key={id} tokenId={token.id} name={name} />
        );
    }
  };

  // A group's one-line summary, shown while it is folded.
  const effects = actor?.effects?.length ?? 0;
  const hpWords = hpUnits({ actor: actor as Parameters<typeof hpUnits>[0]["actor"], hpVisibility: token.hpVisibility, fullAccess: access.full }).map(unitText).join(" ");
  const rings = token.rangeRings ?? [];
  const height = elevationBadge(token.elevation);
  const noteCount = [token.notes, actor?.notes, access.dm ? actor?.dmNotes : undefined].filter((n) => typeof n === "string" && n.trim() !== "").length;
  const groups: Record<PanelGroupId, { label: string; icon: IconName; key: FoldKey; summary?: string }> = {
    combat: { label: "Combat", icon: "combat", key: relationKey("combat", relation), summary: combatSummary({ hp: hpWords, effects, reactionUsed: spent, rings }) },
    notes: { label: "Notes", icon: "notes", key: relationKey("notes", relation), summary: noteCount === 0 ? "None yet" : `${noteCount} ${noteCount === 1 ? "note" : "notes"}` },
    position: { label: "Position", icon: "position", key: "position", summary: [height ? `Elevation ${height} ft` : "On the ground", token.rotation ? `facing ${token.rotation}°` : ""].filter(Boolean).join(", ") },
    image: { label: "Image", icon: "image", key: "image" },
  };
  return (
    <div style={{ fontSize: theme.font.body14 }}>
      {parts.map((part) => {
        if (part.group === null) return section(part.id);
        const g = groups[part.group];
        return (
          <Group key={part.group} label={g.label} icon={g.icon} {...groupFold(g.key)} summary={g.summary} holds="sections">
            {part.sections.map(section)}
          </Group>
        );
      })}
    </div>
  );
}

/**
 * The token's header (CreatureHeader.tsx): its picture as the image field
 * previews it, the name, the kind line and the tags. A companion names its
 * character in the tracker's words (docs/design-v1-combat-flow.md 3.6.7),
 * and wears its portrait, for whoever's copy holds the link.
 */
function NameBlock(props: { token: Token; name: string; actor: Partial<Actor> | undefined; character: Character | undefined; feetPerCell: number; children?: ReactNode }) {
  const { token } = props;
  const keeper = useRoomView((s) => (token.companion ? s.view?.characters[token.companion.of] : undefined));
  const you = useRoomView((s) => s.you);
  const ui = useRoomUi();
  const scope = useRoomScope();
  const here = usePanelHere();
  // "Companion of Thorn" opens Thorn's page where the viewer has one to open: the DM, and Thorn's players (docs/design-v1-look-pass.md 2.11).
  const openKeeper =
    keeper && (you?.role === "dm" || ownsCharacter(you?.memberId, keeper))
      ? () => {
          openCharacterPage(scope.get(characterPageSlot), keeper.id);
          ui.openPanel("characters", here ? { from: here } : undefined);
        }
      : null;
  const fp = footprint(token);
  // What carries it and what it carries, from the links in this copy (docs/design-v1-attach.md 4.5).
  const linkTags = usePanelLinkTags(token);
  // The tracker's words and icons for the same states (docs/design-v1-icons-2.md 5): "Hidden" with the eye struck through fits a 320 px phone at 130% where "Hidden from players" with it would cut.
  const tags: (string | HeaderTag)[] = [];
  if (token.visibility === "dm") tags.push({ text: "Hidden", icon: "hidden", title: "Hidden from players", spoken: "from players" });
  if (token.locked) tags.push({ text: "Locked", icon: "locked" });
  // Words alone: the Hidden tag beside it already draws the struck-out eye (docs/design-v1-icons-2.md 3.2).
  if (token.nameHidden) tags.push("Name hidden");
  tags.push(...linkTags);
  const kind = tokenKind({ token, companionOf: keeper?.name, character: props.character, cr: props.actor?.cr });
  return (
    <CreatureHeader
      picture={{ image: token.image, shape: token.kind === "object" ? "square" : "circle", aspect: fp.w / fp.h, ring: DISPOSITION_RING[token.disposition] ?? theme.color.neutral, initials: initials(props.name) }}
      badge={keeper ? { image: keeper.defaultImage, initials: initials(keeper.name) } : null}
      name={props.name}
      line={kindLine(kind, sizeText(token.size, fp, props.feetPerCell))}
      onCompanionOf={openKeeper}
      // Focus lands here once a press selected another token and the panel remounted for it, as Duplicate's does.
      focusable
      tags={tags}
      afterTags={<SteerControl token={token} />}
    >
      {props.children}
    </CreatureHeader>
  );
}

/** The image's buttons and the other images, in the Image group (docs/design-v1-dice-ui.md 5.2): the picture itself stands beside the name. */
function ImageRow(props: { token: Token; name: string; access: TokenAccess; update(patch: TokenPatch): void }) {
  const { token, access, update } = props;
  const fp = footprint(token);
  const shape = token.kind === "object" ? "square" : "circle";
  const ring = DISPOSITION_RING[token.disposition] ?? theme.color.neutral;
  const alts = useAltImages({ token, shape, aspect: fp.w / fp.h, ring, onPatch: update });
  // No padding of its own: the Image group's body pads it, as a section in a group has none.
  return (
    <div>
      <ImageField
        value={token.image}
        onChange={(image) => update({ image })}
        shape={shape}
        aspect={fp.w / fp.h}
        canEdit={access.canEditToken("image")}
        ring={ring}
        initials={initials(props.name)}
        previewSize={48}
        extra={access.canEditToken("altImages") ? alts : { beside: null }}
      />
    </div>
  );
}

function PositionSection(props: { token: Token; access: TokenAccess; update(patch: TokenPatch): void }) {
  const { token, access, update } = props;
  const canElevate = access.canEditToken("elevation");
  const canRotate = access.canEditToken("rotation");
  const rotation = (((token.rotation ?? 0) % 360) + 360) % 360;
  if (!canElevate && !canRotate) {
    const badge = elevationBadge(token.elevation);
    // No label of their own: the Position group's heading names them.
    return (
      <Section>
        <Note>{badge ? `Elevation ${badge} ft` : "On the ground"}</Note>
      </Section>
    );
  }
  return (
    <Section>
      {canElevate ? (
        <FieldRow label="Elevation" hint="Feet. Negative is below ground." fixed>
          <Stepper label="Elevation" value={token.elevation ?? 0} step={5} min={-100_000} max={100_000} onChange={(elevation) => update({ elevation })} />
        </FieldRow>
      ) : null}
      <GroundNotice token={token} />
      {canRotate ? (
        <FieldRow label="Facing" hint="Degrees clockwise" fixed>
          <Stepper label="Facing" value={rotation} step={45} min={-360} max={360} onChange={(r) => update({ rotation: ((r % 360) + 360) % 360 })} />
        </FieldRow>
      ) : null}
    </Section>
  );
}

/**
 * Position's attach controls (docs/design-v1-token-sections.md 3.3), each
 * as the token's bar offers it: the group line whole, its names with Let
 * go or Put down beside each token it holds, then Get off, Put down or Let
 * go on a carried token and Attach, with Get off's note when there is no
 * room. A viewer who is neither the DM nor an owner gets these alone, so a
 * Let go always stands beside the name of what it releases (SECTIONS-R3-16).
 * A phone opens Attach's list in a sheet over the panel's own, as the bar
 * does, and a wide screen in a pop-up.
 */
function AttachControls(props: { token: Token }) {
  const { token } = props;
  const slots = useAttachSlots(token);
  const detach = useDetach(token, slots.includes("detach"));
  const noteId = useId();
  return (
    <Section>
      <div data-attach-controls="" style={{ display: "grid", gap: theme.space(2) }}>
        <GroupLine token={token} focusTo={ATTACH_FOCUS} nameFocusTo={TO_NAME} />
        {slots.length > 0 ? (
          // Each keeps its own width, as the panel's other buttons do: the bar's grow to share its play row.
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1) }}>
            {slots.map((slot) => (
              <span key={slot} style={{ display: "flex" }}>
                {slot === "detach" ? <DetachButton token={token} detach={detach} noteId={noteId} focusTo={ATTACH_FOCUS} /> : <AttachButton token={token} />}
              </span>
            ))}
          </div>
        ) : null}
        {slots.includes("detach") ? <DetachNote detach={detach} id={noteId} /> : null}
      </div>
    </Section>
  );
}

/**
 * A companion's player dismisses it in Delete's place, with the bar's own
 * button (docs/design-v1-combat-flow.md 3.6.9). Focus goes to what the
 * panel shows next (D-261024-47): the creature still selected, by its name,
 * or else the empty line. The panel first shows its empty state while the
 * dismissed companion is still selected, until the map lets go of it
 * (Stage's keepSelected), so the target is read from the selection, and the
 * hand-off waits until the panel draws it.
 */
function DismissSection(props: { tokenId: string; name: string }) {
  const store = useRoomStore();
  const handOff = useCallback(
    (button: HTMLElement) => {
      const scope = button.closest<HTMLElement>(PANEL_BOX);
      handFocusWhenFound(() => scope?.querySelector<HTMLElement>(store.getState().local.selectedIds.length > 0 ? CREATURE_HEADING : EMPTY_LINE) ?? null);
    },
    [store],
  );
  return (
    <Section title="Remove">
      <div>
        <DismissButton tokenId={props.tokenId} name={props.name} handOff={handOff} />
      </div>
    </Section>
  );
}

/** An owner's Name and, on a PC, "Name others see", for a token they may rename: a PC's or a companion's (docs/design-v1-combat-flow.md 3.6.4). */
function OwnerNames(props: { token: Token; access: TokenAccess; update(patch: TokenPatch): void }) {
  const { token, update } = props;
  return (
    <>
      <FieldRow label="Name" fill>
        <TextField label="Name" value={token.name} maxLength={80} onCommit={(v) => v.trim() && update({ name: v.trim() })} />
      </FieldRow>
      {props.access.canEditToken("publicName") ? (
        <FieldRow label="Name others see" fill hint="Used when the DM hides the name">
          <TextField label="Name others see" value={token.publicName ?? ""} maxLength={80} onCommit={(v) => update({ publicName: v.trim() || null })} />
        </FieldRow>
      ) : null}
    </>
  );
}

/** The DM's setup for a token: its name, kind, size, ring, layer, HP view, hiding, lock, fog and height. */
function DmSettings(props: { token: Token; feetPerCell: number; update(patch: TokenPatch): void }) {
  const { token, update } = props;
  const fp = footprint(token);
  const autoHeight = Math.max(fp.w, fp.h) * props.feetPerCell;
  // A creature companion a player plays is the party's, so its HP follows the party's setting (docs/design-v1-combat-flow.md 3.6.5).
  const followsParty = useRoomView((s) => followsPartyHp(s.view, token));
  const actions = useRoomActions();
  const encounter = useRoomView((s) => s.view?.encounter);
  return (
    <>
      <FieldRow label="Name" fill>
        <TextField label="Name" value={token.name} maxLength={80} onCommit={(v) => v.trim() && update({ name: v.trim() })} />
      </FieldRow>
      <Switch checked={token.nameHidden} onChange={(nameHidden) => update({ nameHidden })} label="Hide the name from players" />
      {token.nameHidden ? (
        <FieldRow label="Name players see" fill hint="Empty shows “Unknown creature”">
          <TextField
            label="Name players see"
            value={token.publicName ?? ""}
            maxLength={80}
            placeholder="Unknown creature"
            onCommit={(v) => update({ publicName: v.trim() || null })}
          />
        </FieldRow>
      ) : null}
      <FieldRow label="Kind" fill>
        <Select<TokenKind> label="Kind" value={token.kind} options={KIND_OPTIONS} onChange={(kind) => update({ kind })} />
      </FieldRow>
      <FieldRow label="Ring" fill>
        <Select<Token["disposition"]>
          label="Disposition"
          value={token.disposition}
          options={[
            { value: "ally", label: "Ally (blue)" },
            { value: "neutral", label: "Neutral (gray)" },
            { value: "hostile", label: "Hostile (red)" },
          ]}
          onChange={(disposition) => update({ disposition })}
        />
      </FieldRow>
      <FieldRow label="Layer" fill>
        <Select<Token["layer"]>
          label="Layer"
          value={token.layer}
          options={[
            { value: "token", label: "Creatures" },
            { value: "object", label: "Objects, under creatures" },
          ]}
          onChange={(layer) => update({ layer })}
        />
      </FieldRow>
      <FieldRow label="Players see HP as" fill>
        {followsParty ? (
          <span style={{ flex: 1, color: theme.color.textMuted }}>Follows Players see the party's HP</span>
        ) : (
          <Select<HpVisibility> label="Players see HP as" value={token.hpVisibility} options={HP_VISIBILITY_OPTIONS} onChange={(hpVisibility) => update({ hpVisibility })} />
        )}
      </FieldRow>
      <Switch
        checked={token.visibility === "dm"}
        onChange={(hidden) => {
          const change: ClientOp = { t: "token.update", tokenId: token.id, patch: { visibility: hidden ? "dm" : "all" } };
          dispatchGesture(actions, hidden ? [change] : [change, ...shownRowOps(encounter, [token.id])]);
        }}
        label="Hidden from players"
        help="Never sent to players while hidden."
      />
      <Switch checked={token.locked} onChange={(locked) => update({ locked })} label="Locked" help="Nobody can drag it." />
      <Switch
        checked={token.fogExempt}
        onChange={(fogExempt) => update({ fogExempt })}
        label="Always visible, even under fog"
        help="When off, players lose sight of it while it stands fully in the fog."
      />
      <FieldRow label="Height" hint={`Feet. Empty uses the size: ${autoHeight} ft.`}>
        <NumberField label="Height" value={token.height} min={0} max={10_000} nullable placeholder={`${autoHeight}`} onCommit={(height) => update({ height })} />
      </FieldRow>
      {offersMakeCompanion({ dm: true, kind: token.kind, companion: isCompanion(token) }) ? <MakeCompanion token={token} /> : null}
      <DuplicateButton token={token} />
    </>
  );
}

/** The bar's Duplicate, worded, last in the DM's Token settings (docs/design-v1-token-sections.md 3.4). */
function DuplicateButton(props: { token: Token }) {
  const duplicate = useDuplicate(props.token, TO_NAME);
  return (
    <div>
      <Button size="sm" icon="duplicate" onClick={duplicate}>
        Duplicate
      </Button>
    </div>
  );
}

/**
 * The creature's size on the map, first in Stats (docs/design-v1-token-window.md
 * 8.10), the one place that edits it: for the DM the six sizes and Custom
 * with its width by height, for an owner who may resize the six, and
 * read-only for an owner of a locked or a Custom token. "Back to Medium"
 * follows where the creature's own size is known and the token is neither
 * of it (8.8). Every change goes through the one resize patch
 * (features/tokens/resize.ts), so the panel and the window place the
 * footprint alike, and a refusal's words show under the field.
 */
function SizeField(props: { token: Token; actor: Partial<Actor>; access: TokenAccess; feetPerCell: number }) {
  const { token, access } = props;
  const resize = useResize();
  const [refused, setRefused] = useState<string | null>(null);
  const characters = useRoomView((s) => s.view?.characters);
  const monsters = useRoomView((s) => s.view?.monsters);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  // A companion's stored block or a room monster's comes first, so the SRD loads only when it is the link (statBlockLink.ts tokenStatBlock).
  const srd = useSrdList(props.actor.srdId !== undefined && props.actor.monsterId === undefined && props.actor.blockId === undefined);
  // A refusal belongs to the size it was about: a new size, or a new token, clears it.
  useEffect(() => setRefused(null), [token.id, token.size, token.w, token.h]);
  const fp = footprint(token);
  const send = (next: NextSize) => setRefused(resize(token, next, { toast: false }));
  if (!access.dm && token.size === "custom") return <FieldRow label="Size">{customWords(token, true)}</FieldRow>;
  if (!access.dm && (token.locked || !access.resize)) {
    return (
      <FieldRow label="Size">
        {SIZE_WORDS[token.size]} ({fp.w * props.feetPerCell} ft), locked by the DM
      </FieldRow>
    );
  }
  const base = backTo(token.size, baseSize({ token, actor: props.actor, characters, monsters, blocks, srd: srd.list }));
  const options = access.dm ? SIZE_OPTIONS : SIZE_OPTIONS.filter((o) => o.value !== "custom");
  return (
    <>
      <FieldRow label="Size" fill hint={refused ? <span role="alert">{refused}</span> : undefined}>
        <Select<CreatureSize>
          label="Size"
          value={token.size}
          options={options}
          onChange={(size) => send(size === "custom" ? { size, w: fp.w, h: fp.h } : { size })}
        />
      </FieldRow>
      {access.dm && token.size === "custom" ? (
        <FieldRow label="Width by height" hint="Squares, 0.5 to 20">
          <CellsField label="Width in squares" value={token.w ?? fp.w} onCommit={(w) => send({ size: "custom", w, h: token.h ?? fp.h })} />
          <span style={{ color: theme.color.textMuted }}>by</span>
          <CellsField label="Height in squares" value={token.h ?? fp.h} onCommit={(h) => send({ size: "custom", w: token.w ?? fp.w, h })} />
        </FieldRow>
      ) : null}
      {base ? (
        <div>
          <Button size="sm" onClick={() => send({ size: base })}>
            Back to {SIZE_WORDS[base]}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function CellsField(props: { label: string; value: number; onCommit(value: number): void }) {
  return (
    <TextField
      label={props.label}
      value={String(props.value)}
      onCommit={(v) => {
        const n = Math.round(Number(v) * 2) / 2;
        if (Number.isFinite(n)) props.onCommit(Math.min(20, Math.max(0.5, n)));
      }}
      style={{ maxWidth: 72, textAlign: "center" }}
    />
  );
}

/** Who controls the token. A PC token is also owned through its character, which the character card sets. Folded, the names show beside its label. */
function Owners(props: { token: Token; update(patch: TokenPatch): void; group: { open: boolean; onToggle(): void } }) {
  const { token, update } = props;
  const members = useRoomView((s) => s.view?.members);
  const owners = token.ownerIds ?? [];
  const list = Object.values(members ?? {}).sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "player" ? -1 : 1,
  );
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const through = (character?.ownerIds ?? []).map((id) => members?.[id]?.name).filter(Boolean);
  const names = owners.map((id) => members?.[id]?.name).filter((n): n is string => !!n);
  if (token.companion) {
    // A companion's owners are its character's, kept in step by the server (docs/design-v1-combat-flow.md 3.6.4).
    return (
      <Group label="Owners" icon="group" {...props.group} summary={names.length > 0 ? names.join(", ") : "None"}>
        <CompanionOwners token={token} />
      </Group>
    );
  }
  const everyone = tokenOwnerIds({ characters: character ? { [character.id]: character } : {} }, token)
    .map((id) => members?.[id]?.name)
    .filter((n): n is string => !!n);
  return (
    <Group label="Owners" icon="group" {...props.group} summary={everyone.length > 0 ? everyone.join(", ") : "None"}>
      <Note>Owners can move it and edit what their role allows.</Note>
      <div style={{ display: "grid" }}>
        {list.map((m) => (
          <Checkbox
            key={m.id}
            checked={owners.includes(m.id)}
            onChange={(on) => update({ ownerIds: on ? [...owners, m.id] : owners.filter((id) => id !== m.id) })}
            label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2) }}>
                <RowDot color={m.color} size={12} />
                {m.name}
                {m.kind === "dm" ? <span style={{ color: theme.color.textMuted }}>(DM)</span> : null}
              </span>
            }
          />
        ))}
      </div>
      {through.length > 0 ? (
        <Note>
          Also owned through {character?.name}: {through.join(", ")}.
        </Note>
      ) : null}
    </Group>
  );
}

function DmActions(props: { token: Token; onDeleted(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  return (
    <Section title="Remove">
      <ConfirmButton
        icon="delete"
        confirm="Tap again to delete"
        onConfirm={() => {
          actions.dispatch({ t: "token.delete", tokenId: props.token.id });
          ui.select(null);
          props.onDeleted();
        }}
      >
        Delete this token
      </ConfirmButton>
    </Section>
  );
}
