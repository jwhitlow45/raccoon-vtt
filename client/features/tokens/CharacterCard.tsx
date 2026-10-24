import { useId, useMemo, useState, type ReactNode } from "react";
import { SIZE_CELLS, type Character, type CreatureSize, type Member, type RoomState } from "#shared/model.ts";
import { playsAlone } from "#shared/permissions.ts";
import type { ActorPatch, CharacterPatch, TokenInput } from "#shared/protocol.ts";
import { hpLess } from "#shared/rules/hp.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { FieldRow, Select } from "../../components/Field.tsx";
import { Group, Help, Note, Section } from "../../components/Panel.tsx";
import { RowDot } from "../../components/Row.tsx";
import { theme } from "../../lib/theme.ts";
import { initials } from "../../lib/tokenView.ts";
import { useRoomScope, type RoomScope } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { usePreview } from "../dm/previewContext.ts";
import { useAnyPending } from "../encounter/hooks.ts";
import { ImageField, type ImageRef } from "../images/ImageField.tsx";
import { placeOnGround } from "../movement/ground.ts";
import { PcStatBlock } from "../pcstats/PcStatBlock.tsx";
import { ClassResourcesSection } from "../resources/ClassResourcesSection.tsx";
import { currentStageCamera } from "../scenes/stageCamera.ts";
import { characterAccess } from "./access.ts";
import { deleteWarning, sharedNote } from "./characterDelete.ts";
import { CharacterCompanions } from "./CompanionsSection.tsx";
import { CreatureHeader } from "./CreatureHeader.tsx";
import { characterKind, kindLine, sizeText } from "./creatureKind.ts";
import { EffectsSection } from "./EffectsSection.tsx";
import { HpSection } from "./HpSection.tsx";
import { usePanelFolds, type FoldKey } from "./panelFolds.ts";
import { cardGroups, type CardPartId } from "./panelOrder.ts";
import { PLACE_TOOL_ID, setPending } from "./placement.ts";
import { onScene, playerToken } from "./playerCharacters.ts";
import { QuickNumbers } from "./QuickNumbers.tsx";
import { RestSection } from "./RestSection.tsx";
import { hpUnits, unitText, vitals } from "./statSummary.ts";
import { CardNotesField, SheetUrlField, StatsFields } from "./StatsSection.tsx";
import { ConfirmButton, NumberField, TextField } from "./ui.tsx";
import { isAssetImage } from "#shared/imageRef.ts";
import type { PanelClose } from "../panels.ts";

export const SIZE_OPTIONS: { value: CreatureSize; label: string }[] = [
  { value: "tiny", label: "Tiny" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "huge", label: "Huge" },
  { value: "gargantuan", label: "Gargantuan" },
];

/**
 * A player character's page in the Characters panel (features section 15,
 * docs/design-v1-look-pass.md 3.1), for the DM and the character's players.
 * The character lives at room level and every token of it points here, so
 * HP and conditions follow the PC from scene to scene. It opens as the token
 * panel does, with the creature's header and the stat block under it, then
 * the token panel's groups by use (panelOrder.ts cardGroups), each as this
 * device last left it (panelFolds.ts). Only the stat block's fold is shared
 * with the token panel. It holds nothing of a token on a map: no position,
 * sight, range rings or token settings.
 *
 * The DM edits everything. The owning player edits the fields design 8.1
 * allows: name, image, level, HP and the stat card's numbers, senses,
 * notes, the sheet link and the stat block (docs/design-v1-pc-stats.md 7.1).
 */
export function CharacterPage(props: { character: Character; close: PanelClose; onAddCompanion(): void; onBlocks(): void; onDelete(): number | null }) {
  const { character } = props;
  const actions = useRoomActions();
  const you = useRoomView((s) => s.you);
  const tokens = useRoomView((s) => s.view?.tokens);
  const members = useRoomView((s) => s.view?.members);
  const feetPerCell = useRoomView((s) => s.view?.meta.settings.feetPerCell ?? 5);
  const access = useMemo(
    () => characterAccess({ role: you?.role ?? "player", memberId: you?.memberId, character }),
    [you, character],
  );
  const { folds, slot } = usePanelFolds();
  const preview = usePreview() !== null;
  // A viewer's tap is what this device remembers. "View as a player" reads what is stored and never writes it.
  const fold = (key: FoldKey) => ({ open: folds[key], onToggle: () => slot.tap(key, !folds[key], !preview) });
  const update = (patch: CharacterPatch) => actions.dispatch({ t: "character.update", characterId: character.id, patch });
  const patchActor = (patch: ActorPatch) => update({ actor: patch });

  /**
   * A new portrait also goes on this character's tokens in view that still
   * show the old one, so the map changes with the page. Tokens given their
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

  const { actor } = character;
  // A character's size is one of the six: Custom is a token's alone.
  const cells = character.size === "custom" ? 1 : SIZE_CELLS[character.size];
  const notes = access.canEditActor("notes") || !!actor.notes?.trim() || access.dm;
  const parts = cardGroups({ dm: access.dm, plays: access.owner, statBlock: access.full, companions: true, notes, image: access.canEdit("defaultImage") });

  // A group's one-line summary, shown while it is folded, in the token panel's words.
  const effects = actor.effects?.length ?? 0;
  const hpWords = hpUnits({ actor, hpVisibility: undefined, fullAccess: access.full }).map(unitText).join(" ");
  const noteCount = [actor.notes, access.dm ? actor.dmNotes : undefined].filter((n) => typeof n === "string" && n.trim() !== "").length;

  const part = (id: CardPartId): ReactNode => {
    switch (id) {
      case "header":
        return (
          <CreatureHeader
            key={id}
            picture={{ image: character.defaultImage, shape: "circle", aspect: 1, ring: theme.color.ally, initials: initials(character.name) }}
            name={character.name}
            line={kindLine(characterKind(character), sizeText(character.size, { w: cells, h: cells }, feetPerCell))}
            focusable
            tags={[]}
          >
            <QuickNumbers items={vitals({ actor, token: { kind: "pc" }, fullAccess: access.full, place: "panel" })} actor={actor} token={{ kind: "pc", elevation: 0 }} />
          </CreatureHeader>
        );
      case "place":
        return access.dm ? <PlaceToken key={id} character={character} close={props.close} /> : <PlaceMine key={id} character={character} close={props.close} />;
      case "statBlock":
        // The one fold the page shares with the token panel: the `own` relation's, as every viewer of the page plays or runs the character.
        return <PcStatBlock key={id} character={character} fold={fold("statBlock")} />;
      case "combat":
        return (
          <Group key={id} label="Combat" {...fold("page.combat")} summary={[hpWords, effects > 0 ? `${effects} ${effects === 1 ? "condition" : "conditions"}` : ""].filter(Boolean).join(" · ")} holds="sections">
            <HpSection
              actor={actor}
              hpVisibility={undefined}
              target={{ characterId: character.id }}
              access={{ full: access.full, hp: access.full ? "all" : "none", deathSaves: access.full, life: access.dm }}
              name={character.name}
            />
            <EffectsSection effects={actor.effects ?? []} target={{ characterId: character.id }} self={{ characterId: character.id }} selfLabel={character.name} canEdit={access.full} />
            <RestSection actor={actor} target={{ characterId: character.id }} resources={character.resources} />
            <ClassResourcesSection character={character} />
          </Group>
        );
      case "companions":
        return <CharacterCompanions key={id} character={character} canAdd onAdd={props.onAddCompanion} onBlocks={props.onBlocks} close={props.close} group={fold("page.companions")} />;
      case "notes":
        return (
          <Group key={id} label="Notes" {...fold("page.notes")} summary={noteCount === 0 ? "None yet" : `${noteCount} ${noteCount === 1 ? "note" : "notes"}`}>
            <Labeled label="On the card" hint="The DM and this character's players read it.">
              <CardNotesField actor={actor} editable={access.canEditActor("notes")} onPatch={patchActor} label="Card notes" rows={2} />
            </Labeled>
            {access.dm ? (
              <Labeled label="For DMs only" hint="Never sent to players, this character's players included.">
                <TextField label="Note for DMs only" multiline rows={2} value={actor.dmNotes ?? ""} maxLength={4000} placeholder="Only DMs see this" onCommit={(dmNotes) => patchActor({ dmNotes })} />
              </Labeled>
            ) : null}
          </Group>
        );
      case "image":
        return (
          <Group key={id} label="Image" {...fold("page.image")}>
            <ImageField
              value={character.defaultImage}
              onChange={setImage}
              shape="circle"
              aspect={1}
              canEdit={access.canEdit("defaultImage")}
              ring={theme.color.ally}
              initials={initials(character.name)}
              previewSize={48}
            />
          </Group>
        );
      case "stats":
        return (
          <Group key={id} label="Stats" {...fold("page.stats")}>
            {access.canEdit("name") ? (
              <FieldRow label="Name" fill>
                <TextField label="Character name" value={character.name} maxLength={80} onCommit={(v) => v.trim() && update({ name: v.trim() })} />
              </FieldRow>
            ) : null}
            {access.dm ? (
              <FieldRow label="Size" fill>
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
              <FieldRow label="Level" hint={access.dm ? "The encounter builder's XP budget counts it. Sets the Proficiency Bonus too." : "Sets the Proficiency Bonus too."}>
                <NumberField label="Character level" value={character.level} min={1} max={20} nullable placeholder="Not set" onCommit={(level) => update({ level })} />
              </FieldRow>
            ) : null}
            <StatsFields actor={actor} canEdit={access.canEditActor} onPatch={patchActor} dm={access.dm} noAc={hpLess(actor)} fromBlock={character.stats !== undefined} />
            {access.canEditActor("sheetUrl") ? (
              <FieldRow label="Sheet link" fill>
                <SheetUrlField value={actor.sheetUrl ?? ""} onPatch={patchActor} />
              </FieldRow>
            ) : null}
          </Group>
        );
      case "owners":
        return <CharacterOwners key={id} character={character} members={members} update={update} group={fold("page.owners")} />;
      case "remove":
        return you && (access.dm || playsAlone(you.memberId, character)) ? (
          <RemoveCharacter key={id} character={character} dm={access.dm} onDelete={props.onDelete} />
        ) : you && members ? (
          <Section key={id} label="Remove">
            {/* The name may be one unbroken word as long as the protocol allows, so it breaks anywhere, as the delete line does. */}
            <Help style={{ overflowWrap: "anywhere" }}>{sharedNote(you.memberId, character, members)}</Help>
          </Section>
        ) : null;
    }
  };

  return <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", fontSize: theme.font.body14 }}>{parts.map(part)}</div>;
}

/** A note's audience above it, since a text box needs the panel's full width, as the token panel's Notes reads (TokenNotes.tsx). */
function Labeled(props: { label: string; hint: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "grid", gap: theme.space(0.5) }}>
        <div style={{ fontSize: theme.font.body14 }}>{props.label}</div>
        <Help>{props.hint}</Help>
      </div>
      {props.children}
    </div>
  );
}

/** Who plays the character, the DM's to choose. Folded, their names show beside its label. */
function CharacterOwners(props: { character: Character; members: RoomState["members"] | undefined; update(patch: CharacterPatch): void; group: { open: boolean; onToggle(): void } }) {
  const owners = props.character.ownerIds ?? [];
  const players = Object.values(props.members ?? {}).filter((m): m is Member => !!m && m.kind === "player");
  const names = players.filter((m) => owners.includes(m.id)).map((m) => m.name);
  return (
    <Group label="Played by" {...props.group} summary={names.length > 0 ? names.join(", ") : "No player yet"}>
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
    </Group>
  );
}

/** The DM's "Place a token", under the header: the place tool, holding this character. */
function PlaceToken(props: { character: Character; close: PanelClose }) {
  const { character } = props;
  const ui = useRoomUi();
  const scope = useRoomScope();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), paddingBottom: theme.space(2) }}>
      <Button
        size="sm"
        onClick={() => {
          setPending(scope, { kind: "character", characterId: character.id, name: character.name });
          ui.setTool(PLACE_TOOL_ID);
          props.close({ placing: true });
        }}
      >
        Place a token
      </Button>
    </div>
  );
}

/** The token a player puts down for a character of theirs: in the middle of the map they are looking at. */
export function myToken(scope: RoomScope, input: Omit<Parameters<typeof playerToken>[0], "center"> & { view: Pick<RoomState, "buildChunks"> }): TokenInput | null {
  const live = currentStageCamera(scope);
  const center = live
    ? { x: (live.viewport.width / 2 - live.camera.x) / live.camera.scale, y: (live.viewport.height / 2 - live.camera.y) / live.camera.scale }
    : { x: input.scene.bounds.w / 2, y: input.scene.bounds.h / 2 };
  const token = playerToken({ ...input, center });
  return token && placeOnGround(input.view.buildChunks, token);
}

/** "Place my token" for a player's own character, when the room lets players place them. */
function PlaceMine(props: { character: Character; close(): void }) {
  const { character } = props;
  const view = useRoomView((s) => s.view);
  const you = useRoomView((s) => s.you);
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const scene = view?.meta.playerSceneId ? view.scenes[view.meta.playerSceneId] : undefined;
  if (!view || !you || !scene || view.meta.settings.playersCreateCharacters !== true) return null;
  if (onScene(view, character.id, scene.id)) return <Help style={{ paddingBottom: theme.space(2), overflowWrap: "anywhere" }}>{character.name} is on the map.</Help>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), paddingBottom: theme.space(2) }}>
      <Button
        size="sm"
        onClick={() => {
          const token = myToken(scope, { view, scene, character, memberId: you.memberId, id: actions.newId() });
          if (!token || actions.dispatch({ t: "token.create", token }) === null) return;
          ui.select(token.id);
          props.close();
        }}
      >
        Place my token
      </Button>
    </div>
  );
}

/**
 * Delete at the foot of a character's page: the DM's for every character,
 * and a player's for one they play alone. The line above it says what goes
 * with it, and is the button's description in both of its states. The
 * delete waits for the server, since only it holds every token of the
 * character on every scene, so the button is busy until the answer, and a
 * refusal is the store's toast. A player's delete is on no undo stack
 * (shared/permissions.ts playsAlone), so their line says it cannot be
 * undone, in the warning tone.
 */
function RemoveCharacter(props: { character: Character; dm: boolean; onDelete(): number | null }) {
  const { character } = props;
  const tokens = useRoomView((s) => s.view?.tokens);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const [sent, setSent] = useState<number | null>(null);
  const waiting = useAnyPending(sent === null ? [] : [sent]);
  const id = useId();
  const warning = deleteWarning({ tokens: tokens ?? {}, encounter }, character, props.dm);
  // A long name breaks anywhere, as the button's label does.
  const wraps = { overflowWrap: "anywhere" } as const;
  return (
    <Section label="Remove">
      {props.dm ? (
        <Help id={id} style={wraps}>
          {warning}
        </Help>
      ) : (
        <Note id={id} style={wraps}>
          {warning}
        </Note>
      )}
      <ConfirmButton confirm="Tap again to delete" busy={waiting} describedBy={id} wrap onConfirm={() => setSent(props.onDelete())}>
        {waiting ? "Deleting…" : `Delete ${character.name}`}
      </ConfirmButton>
    </Section>
  );
}

/** Whether a token still shows the old portrait's picture, whatever its crop: the same upload, or the same icon. */
function samePicture(image: ImageRef, old: ImageRef | undefined): boolean {
  if (!old) return false;
  return isAssetImage(image) ? isAssetImage(old) && image.assetId === old.assetId : !isAssetImage(old) && image.icon === old.icon;
}
