import { useMemo, type ComponentProps, type ReactNode } from "react";
import type { Actor, CreatureSize, HpVisibility, Token, TokenKind } from "#shared/model.ts";
import type { ActorPatch, TokenPatch } from "#shared/protocol.ts";
import { isCompanion } from "../canvas/barButtons.ts";
import { Checkbox } from "../components/Checkbox.tsx";
import { Empty } from "../components/Empty.tsx";
import { Section as PanelSection } from "../components/Panel.tsx";
import { RowDot } from "../components/Row.tsx";
import { Switch } from "../components/Switch.tsx";
import { Tag } from "../components/Tag.tsx";
import { usePreview } from "../features/dm/previewContext.ts";
import type { PanelProps } from "../features/panels.ts";
import { ImageField } from "../features/images/ImageField.tsx";
import { RangeRingsSection } from "../features/measure/RangeRingsSection.tsx";
import { statBlockShown } from "../features/monsters/statBlockLink.ts";
import { GroundNotice } from "../features/movement/GroundNotice.tsx";
import { tokenAccess, type TokenAccess } from "../features/tokens/access.ts";
import { useAltImages } from "../features/tokens/AltImages.tsx";
import { CompanionOwners, CompanionSection, MakeCompanion, followsPartyHp } from "../features/tokens/CompanionsSection.tsx";
import { EffectsSection } from "../features/tokens/EffectsSection.tsx";
import { HpSection } from "../features/tokens/HpSection.tsx";
import { usePanelFolds, type FoldKey } from "../features/tokens/panelFolds.ts";
import { offersMakeCompanion, panelSections, type PanelSectionId } from "../features/tokens/panelOrder.ts";
import { RestSection } from "../features/tokens/RestSection.tsx";
import { StatBlockSection } from "../features/tokens/StatBlockSection.tsx";
import { CardNotesField, SheetUrlField, StatsFields } from "../features/tokens/StatsSection.tsx";
import { VitalsLine } from "../features/tokens/StatSummary.tsx";
import { vitals } from "../features/tokens/statSummary.ts";
import { TokenNotes } from "../features/tokens/TokenNotes.tsx";
import { TokenSight } from "../features/vision/TokenSight.tsx";
import { ConfirmButton, FieldRow, Note, NumberField, Section, Select, Stepper, TextField } from "../features/tokens/ui.tsx";
import { displayName, footprint } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { elevationBadge, initials } from "../lib/tokenView.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../state/view.ts";

const SIZE_OPTIONS: { value: CreatureSize; label: string }[] = [
  { value: "tiny", label: "Tiny" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "huge", label: "Huge" },
  { value: "gargantuan", label: "Gargantuan" },
  { value: "custom", label: "Custom" },
];
const SIZE_NAMES = Object.fromEntries(SIZE_OPTIONS.map((o) => [o.value, o.label])) as Record<CreatureSize, string>;

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

const RING: Record<Token["disposition"], string> = { ally: theme.color.ally, neutral: theme.color.neutral, hostile: theme.color.hostile };

/**
 * The selected token's panel (features sections 5, 7, 8 and 15), in the
 * order docs/design-v1-token-panel.md 3.5 ranks by use (panelOrder.ts):
 * the name, the image, the stat block with the summary line in its header,
 * then HP, conditions, position, range rings, notes, rest and sight, and
 * the setup sections folded at the foot, as this device last left them
 * (panelFolds.ts). The DM and the token's owners, directly or through its
 * character, get its full stat card and the controls their role allows.
 * Everyone else sees the public view: the name the projection gave them,
 * the HP the DM allows, conditions with their rules text, and the
 * elevation.
 */
export default function TokenPanel(props: PanelProps) {
  // One instance per token, so an armed Delete or a half-typed field never carries over to the next token selected.
  return <TokenDetails key={props.selectedTokenId ?? ""} {...props} />;
}

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

  if (!token || !access) return <Empty>Tap a token to see it here.</Empty>;

  const actor: Partial<Actor> | undefined = "inline" in token.actor ? token.actor.inline : character?.actor;
  const fp = footprint(token);
  const name = displayName(token);
  const update = (patch: TokenPatch) => actions.dispatch({ t: "token.update", tokenId: token.id, patch });
  const patchActor = (patch: ActorPatch) => {
    if (access.actorVia === "character" && character) actions.dispatch({ t: "character.update", characterId: character.id, patch: { actor: patch } });
    else update({ actor: patch });
  };
  // A viewer's tap is what this device remembers. "View as a player" reads what is stored and never writes it.
  const fold = (key: FoldKey, summary?: ReactNode) => ({ open: folds[key], onToggle: () => slot.tap(key, !folds[key], !preview), summary: folds[key] ? undefined : summary });
  const companion = isCompanion(token);
  const summaryItems = vitals({ actor, token, fullAccess: access.full, place: "panel" });
  const summary = summaryItems.length > 0 ? <VitalsLine items={summaryItems} /> : null;
  const sections = panelSections({
    dm: access.dm,
    owner: access.owner,
    kind: token.kind,
    companion,
    statBlockShown: statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor }),
    summary: summary !== null,
    actor: actor !== undefined,
    ownerRenames: !access.dm && access.canEditToken("name"),
  });
  const cardNotes =
    access.full && actor && (access.canEditActor("notes") || actor.notes !== undefined) ? (
      <CardNotesField actor={actor} editable={access.canEditActor("notes")} onPatch={patchActor} label="Card notes" rows={2} />
    ) : null;

  const section = (id: PanelSectionId): ReactNode => {
    switch (id) {
      case "name":
        return <NameBlock key={id} token={token} name={name} feetPerCell={feetPerCell} />;
      case "image":
        return <ImageRow key={id} token={token} name={name} access={access} update={update} />;
      case "statBlock":
        return <StatBlockSection key={id} token={token} actor={actor} access={access} patchActor={patchActor} summary={summary} />;
      case "summary":
        return <PanelSection key={id}>{summary}</PanelSection>;
      case "hp":
        return <HpSection key={id} actor={actor} hpVisibility={token.hpVisibility} target={{ tokenId: token.id }} access={access} name={name} token={token} />;
      case "conditions":
        return <EffectsSection key={id} effects={actor?.effects ?? []} target={{ tokenId: token.id }} self={{ tokenId: token.id }} selfLabel={name} canEdit={access.effects} />;
      case "position":
        return <PositionSection key={id} token={token} access={access} update={update} />;
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
        return <RestSection key={id} actor={actor?.hp && actor.life ? { hp: actor.hp, life: actor.life } : undefined} target={{ tokenId: token.id }} />;
      case "sight":
        return <TokenSight key={id} token={token} actor={actor} access={access} update={update} />;
      case "stats":
        return actor ? (
          <Section key={id} title="Stats" fold={fold("stats")}>
            <StatsFields actor={actor} canEdit={access.canEditActor} onPatch={patchActor} dm={access.dm} />
            {access.canEditActor("sheetUrl") ? (
              <FieldRow label="Sheet link">
                <SheetUrlField value={actor.sheetUrl ?? ""} onPatch={patchActor} />
              </FieldRow>
            ) : null}
          </Section>
        ) : null;
      case "settings":
        return (
          <Section key={id} title="Token settings" fold={fold("settings")}>
            {access.dm ? <DmSettings token={token} feetPerCell={feetPerCell} update={update} /> : <OwnerNames token={token} access={access} update={update} />}
          </Section>
        );
      // docs/design-v1-combat-flow.md 3.6.9's section, folded through this panel's folds with its character beside its label.
      case "companion":
        return <CompanionSection key={id} token={token} access={access} fold={(summary) => fold("companion", summary)} />;
      case "owners":
        return <Owners key={id} token={token} update={update} fold={fold} />;
      case "remove":
        return <DmActions key={id} token={token} onDeleted={props.close} />;
    }
  };

  return <div style={{ fontSize: theme.font.body14 }}>{sections.map(section)}</div>;
}

/** The name at the very top, whole and wrapping, then the size and the tags on one wrapping line. */
function NameBlock(props: { token: Token; name: string; feetPerCell: number }) {
  const { token } = props;
  // A companion names its character in the tracker's words (docs/design-v1-combat-flow.md 3.6.7), for whoever's copy holds the link.
  const companionOf = useRoomView((s) => (token.companion ? s.view?.characters[token.companion.of]?.name : undefined));
  const fp = footprint(token);
  const sizeText = fp.w === fp.h ? `${fp.w * props.feetPerCell} ft` : `${fp.w * props.feetPerCell} by ${fp.h * props.feetPerCell} ft`;
  const badges: string[] = [];
  if (companionOf !== undefined) badges.push(`Companion of ${companionOf}`);
  if (token.visibility === "dm") badges.push("Hidden from players");
  if (token.locked) badges.push("Locked");
  if (token.nameHidden) badges.push("Name hidden");
  return (
    <div style={{ display: "grid", gap: theme.space(1), paddingTop: theme.space(2) }}>
      <h3 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{props.name}</h3>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(1) }}>
        <span style={{ color: theme.color.textMuted, fontSize: theme.font.small, marginRight: theme.space(1) }}>
          {SIZE_NAMES[token.size] ?? token.size} ({sizeText}){token.kind === "object" ? ", object" : ""}
        </span>
        {badges.map((b) => (
          <Tag key={b}>{b}</Tag>
        ))}
      </div>
    </div>
  );
}

/** The 48 px preview with its buttons and the other images in one column beside it, or under it where the panel is narrow (3.6). */
function ImageRow(props: { token: Token; name: string; access: TokenAccess; update(patch: TokenPatch): void }) {
  const { token, access, update } = props;
  const fp = footprint(token);
  const shape = token.kind === "object" ? "square" : "circle";
  const ring = RING[token.disposition] ?? theme.color.neutral;
  const alts = useAltImages({ token, shape, aspect: fp.w / fp.h, ring, onPatch: update });
  return (
    <div style={{ padding: `${theme.space(3)}px 0 ${theme.space(4)}px` }}>
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
    return (
      <Section title="Position">
        <Note>{badge ? `Elevation ${badge} ft` : "On the ground"}</Note>
      </Section>
    );
  }
  return (
    <Section title="Position">
      {canElevate ? (
        <FieldRow label="Elevation" hint="Feet. Negative is below ground.">
          <Stepper label="Elevation" value={token.elevation ?? 0} step={5} min={-100_000} max={100_000} onChange={(elevation) => update({ elevation })} />
        </FieldRow>
      ) : null}
      <GroundNotice token={token} />
      {canRotate ? (
        <FieldRow label="Facing" hint="Degrees clockwise">
          <Stepper label="Facing" value={rotation} step={45} min={-360} max={360} onChange={(r) => update({ rotation: ((r % 360) + 360) % 360 })} />
        </FieldRow>
      ) : null}
    </Section>
  );
}

/** An owner's Name and, on a PC, "Name others see", for a token they may rename: a PC's or a companion's (docs/design-v1-combat-flow.md 3.6.4). */
function OwnerNames(props: { token: Token; access: TokenAccess; update(patch: TokenPatch): void }) {
  const { token, update } = props;
  return (
    <>
      <FieldRow label="Name">
        <TextField label="Name" value={token.name} maxLength={80} onCommit={(v) => v.trim() && update({ name: v.trim() })} />
      </FieldRow>
      {props.access.canEditToken("publicName") ? (
        <FieldRow label="Name others see" hint="Used when the DM hides the name">
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
  return (
    <>
      <FieldRow label="Name">
        <TextField label="Name" value={token.name} maxLength={80} onCommit={(v) => v.trim() && update({ name: v.trim() })} />
      </FieldRow>
      <Switch checked={token.nameHidden} onChange={(nameHidden) => update({ nameHidden })} label="Hide the name from players" />
      {token.nameHidden ? (
        <FieldRow label="Name players see" hint="Empty shows “Unknown creature”">
          <TextField
            label="Name players see"
            value={token.publicName ?? ""}
            maxLength={80}
            placeholder="Unknown creature"
            onCommit={(v) => update({ publicName: v.trim() || null })}
          />
        </FieldRow>
      ) : null}
      <FieldRow label="Kind">
        <Select<TokenKind> label="Kind" value={token.kind} options={KIND_OPTIONS} onChange={(kind) => update({ kind })} />
      </FieldRow>
      <FieldRow label="Size">
        <Select<CreatureSize>
          label="Size"
          value={token.size}
          options={SIZE_OPTIONS}
          onChange={(size) => (size === "custom" ? update({ size, w: fp.w, h: fp.h }) : update({ size, w: null, h: null }))}
        />
      </FieldRow>
      {token.size === "custom" ? (
        <FieldRow label="Width by height" hint="Squares, 0.5 to 20">
          <CellsField label="Width in squares" value={token.w ?? fp.w} onCommit={(w) => update({ w })} />
          <span style={{ color: theme.color.textMuted }}>by</span>
          <CellsField label="Height in squares" value={token.h ?? fp.h} onCommit={(h) => update({ h })} />
        </FieldRow>
      ) : null}
      <FieldRow label="Ring">
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
      <FieldRow label="Layer">
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
      <FieldRow label="Players see HP as">
        {followsParty ? (
          <span style={{ flex: 1, color: theme.color.textMuted }}>Follows Players see the party's HP</span>
        ) : (
          <Select<HpVisibility> label="Players see HP as" value={token.hpVisibility} options={HP_VISIBILITY_OPTIONS} onChange={(hpVisibility) => update({ hpVisibility })} />
        )}
      </FieldRow>
      <Switch
        checked={token.visibility === "dm"}
        onChange={(hidden) => update({ visibility: hidden ? "dm" : "all" })}
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
function Owners(props: { token: Token; update(patch: TokenPatch): void; fold(key: FoldKey, summary?: ReactNode): ComponentProps<typeof Section>["fold"] }) {
  const { token, update } = props;
  const members = useRoomView((s) => s.view?.members);
  const owners = token.ownerIds ?? [];
  const list = Object.values(members ?? {}).sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "player" ? -1 : 1,
  );
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const through = (character?.ownerIds ?? []).map((id) => members?.[id]?.name).filter(Boolean);
  const names = owners.map((id) => members?.[id]?.name).filter((n): n is string => !!n);
  const summary = (
    <span style={{ flex: "0 1 auto", minWidth: 0, color: theme.color.textMuted, fontSize: theme.font.small, overflowWrap: "anywhere" }}>{names.length > 0 ? names.join(", ") : "None"}</span>
  );
  if (token.companion) {
    // A companion's owners are its character's, kept in step by the server (docs/design-v1-combat-flow.md 3.6.4).
    return (
      <Section title="Owners" fold={props.fold("owners", summary)}>
        <CompanionOwners token={token} />
      </Section>
    );
  }
  return (
    <Section title="Owners" fold={props.fold("owners", summary)}>
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
    </Section>
  );
}

function DmActions(props: { token: Token; onDeleted(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  return (
    <Section title="Remove">
      <ConfirmButton
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
