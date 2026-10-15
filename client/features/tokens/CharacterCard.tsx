import { useMemo } from "react";
import type { Character, CreatureSize, Member } from "#shared/model.ts";
import type { ActorPatch, CharacterPatch } from "#shared/protocol.ts";
import { Checkbox } from "../../components/Checkbox.tsx";
import { FieldRow, Select } from "../../components/Field.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { RowDot } from "../../components/Row.tsx";
import { theme } from "../../lib/theme.ts";
import { initials } from "../../lib/tokenView.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { ImageField, type ImageRef } from "../images/ImageField.tsx";
import { characterAccess } from "./access.ts";
import { EffectsSection } from "./EffectsSection.tsx";
import { HpSection } from "./HpSection.tsx";
import { RestSection } from "./RestSection.tsx";
import { StatsSection } from "./StatsSection.tsx";
import { NumberField, TextField } from "./ui.tsx";
import { isAssetImage } from "#shared/imageRef.ts";

export const SIZE_OPTIONS: { value: CreatureSize; label: string }[] = [
  { value: "tiny", label: "Tiny" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "huge", label: "Huge" },
  { value: "gargantuan", label: "Gargantuan" },
];

/**
 * A player character's stat card (features section 15). The character
 * lives at room level and every token of it points here, so HP and
 * conditions follow the PC from scene to scene. The DM edits everything.
 * The owning player edits the fields design 8.1 allows: name, image, level,
 * HP and the stat card's numbers, senses, notes and the sheet link.
 */
export function CharacterCard(props: { character: Character }) {
  const { character } = props;
  const actions = useRoomActions();
  const you = useRoomView((s) => s.you);
  const tokens = useRoomView((s) => s.view?.tokens);
  const access = useMemo(
    () => characterAccess({ role: you?.role ?? "player", memberId: you?.memberId, character }),
    [you, character],
  );
  const update = (patch: CharacterPatch) => actions.dispatch({ t: "character.update", characterId: character.id, patch });

  /**
   * A new portrait also goes on this character's tokens in view that still
   * show the old one, so the map changes with the card. Tokens given their
   * own image (a disguise) keep it.
   */
  const setImage = (image: ImageRef | null) => {
    const old = character.defaultImage;
    update({ defaultImage: image });
    for (const token of Object.values(tokens ?? {})) {
      if (!token || !("ref" in token.actor) || token.actor.ref !== character.id) continue;
      if (token.image && !samePicture(token.image, old)) continue;
      actions.dispatch({ t: "token.update", tokenId: token.id, patch: { image } });
    }
  };

  return (
    <div style={{ fontSize: theme.font.body14 }}>
      <div style={{ display: "grid", gap: theme.space(2), paddingBottom: theme.space(3) }}>
        <ImageField
          value={character.defaultImage}
          onChange={setImage}
          shape="circle"
          aspect={1}
          canEdit={access.canEdit("defaultImage")}
          ring={theme.color.ally}
          initials={initials(character.name)}
        />
        {access.canEdit("name") ? (
          <FieldRow label="Name">
            <TextField label="Character name" value={character.name} maxLength={80} onCommit={(v) => v.trim() && update({ name: v.trim() })} />
          </FieldRow>
        ) : null}
        {access.dm ? (
          <FieldRow label="Size">
            <Select aria-label="Size" value={character.size} onChange={(e) => update({ size: e.target.value as CreatureSize })} style={{ flex: 1, maxWidth: "100%" }}>
              {SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </FieldRow>
        ) : null}
        {access.canEdit("level") ? (
          <FieldRow label="Level" hint={access.dm ? "The encounter builder's XP budget counts it." : undefined}>
            <NumberField label="Character level" value={character.level} min={1} max={20} nullable placeholder="Not set" onCommit={(level) => update({ level })} />
          </FieldRow>
        ) : null}
      </div>
      <HpSection
        actor={character.actor}
        hpVisibility={undefined}
        target={{ characterId: character.id }}
        access={{ full: access.full, hp: access.full ? "all" : "none", deathSaves: access.full, life: access.dm }}
      />
      <EffectsSection
        effects={character.actor.effects ?? []}
        target={{ characterId: character.id }}
        self={{ characterId: character.id }}
        selfLabel={character.name}
        canEdit={access.full}
      />
      {access.full ? <RestSection actor={character.actor} target={{ characterId: character.id }} /> : null}
      <StatsSection
        actor={character.actor}
        canEdit={access.canEditActor}
        onPatch={(patch: ActorPatch) => update({ actor: patch })}
        dm={access.dm}
        full={access.full}
      />
      {access.dm ? <CharacterOwners character={character} update={update} /> : null}
    </div>
  );
}

function CharacterOwners(props: { character: Character; update(patch: CharacterPatch): void }) {
  const members = useRoomView((s) => s.view?.members);
  const owners = props.character.ownerIds ?? [];
  const players = Object.values(members ?? {}).filter((m): m is Member => !!m && m.kind === "player");
  return (
    <Section label="Played by">
      {players.length === 0 ? <Help>No players have joined yet.</Help> : null}
      <div>
        {players.map((m) => (
          <Checkbox
            key={m.id}
            checked={owners.includes(m.id)}
            onChange={(on) => props.update({ ownerIds: on ? [...owners, m.id] : owners.filter((id) => id !== m.id) })}
            label={
              <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2) }}>
                <RowDot color={m.color} size={12} />
                {m.name}
              </span>
            }
          />
        ))}
      </div>
    </Section>
  );
}

/** Whether a token still shows the old portrait's picture, whatever its crop: the same upload, or the same icon. */
function samePicture(image: ImageRef, old: ImageRef | undefined): boolean {
  if (!old) return false;
  return isAssetImage(image) ? isAssetImage(old) && image.assetId === old.assetId : !isAssetImage(old) && image.icon === old.icon;
}
