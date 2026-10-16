import { useMemo, useState } from "react";
import type { Character, CreatureSize, Member, RoomState } from "#shared/model.ts";
import type { TokenInput } from "#shared/protocol.ts";
import type { PanelProps } from "../panels.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Empty } from "../../components/Empty.tsx";
import { ErrorText, FieldRow, Input, Select } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { Row, RowList } from "../../components/Row.tsx";
import { theme } from "../../lib/theme.ts";
import { hpDisplay, hpText, initials } from "../../lib/tokenView.ts";
import { currentStageCamera } from "../scenes/stageCamera.ts";
import { useRoomScope, type RoomScope } from "../../state/scope.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { ImageField, type ImageRef } from "../images/ImageField.tsx";
import { ImagePreview } from "../images/IconDisk.tsx";
import { placeOnGround } from "../movement/ground.ts";
import { ownsCharacter } from "./access.ts";
import { CharacterCard, SIZE_OPTIONS } from "./CharacterCard.tsx";
import { CharacterCompanions, CompanionForm } from "./CompanionsSection.tsx";
import { EffectIcon } from "./EffectIcon.tsx";
import { newCharacter } from "./factory.ts";
import { PLACE_TOOL_ID, setPending } from "./placement.ts";
import { newCharacterState, onScene, playerToken } from "./playerCharacters.ts";
import { ConfirmButton, NumberField } from "./ui.tsx";

/**
 * Player characters (features section 15). The DM creates them, picks who
 * plays each one, edits every card and places their tokens. A player sees
 * and edits their own card, and the rest of the party as the projection
 * shows them: name, conditions and the HP the DM allows. When the room
 * lets players create characters, a player also makes their own (theirs
 * alone, a few at most) and puts their tokens on the players' scene.
 */
export default function CharactersPanel(props: PanelProps) {
  const you = useRoomView((s) => s.you);
  const view = useRoomView((s) => s.view);
  const characters = useRoomView((s) => s.view?.characters);
  /** Undefined until the first tap: a player with one character sees that card open. */
  const [openId, setOpenId] = useState<string | null | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  /** The character whose "Add a companion" form shows in the panel's place. */
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const dm = you?.role === "dm";

  const list = useMemo(
    () => Object.values(characters ?? {}).filter((c): c is Character => !!c).sort((a, b) => a.name.localeCompare(b.name)),
    [characters],
  );
  const mine = list.filter((c) => dm || ownsCharacter(you?.memberId, c));
  const others = dm ? [] : list.filter((c) => !ownsCharacter(you?.memberId, c));
  const open = openId === undefined ? (!dm && mine.length === 1 ? (mine[0]?.id ?? null) : null) : openId;

  const own = !dm && view && you ? newCharacterState(view, you.memberId) : null;

  const companionOf = addingFor !== null ? characters?.[addingFor] : undefined;
  if (companionOf) {
    return <CompanionForm character={companionOf} close={props.close} onDone={() => setAddingFor(null)} />;
  }

  if (creating) {
    return (
      <NewCharacter
        close={props.close}
        {...(!dm && you ? { owner: you.memberId } : {})}
        onDone={(id) => {
          setCreating(false);
          if (id) setOpenId(id);
        }}
      />
    );
  }

  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      {dm || own?.allowed ? (
        <Button variant="primary" size="sm" block onClick={() => setCreating(true)}>
          New character
        </Button>
      ) : null}
      {own && !own.allowed && own.reason === "full" ? <Help>You have as many characters as a player can make. Ask the DM for another.</Help> : null}
      {mine.length === 0 ? (
        <Empty>
          {dm
            ? "The party's characters go here. Make one with New character, and pick who plays it."
            : own?.allowed
              ? "Make your character, or wait for the DM to give you one."
              : "The DM has not given you a character yet."}
        </Empty>
      ) : null}
      {mine.map((c) => (
        <CharacterRow
          key={c.id}
          character={c}
          open={open === c.id}
          onToggle={() => setOpenId(open === c.id ? null : c.id)}
          close={props.close}
          onAddCompanion={() => setAddingFor(c.id)}
        />
      ))}
      {/* A long rest comes once a day and the list is read every time, so the rest waits below it (docs/design-v1-layout-hierarchy.md M8). */}
      {dm && list.length > 0 ? <PartyLongRest characters={list} /> : null}
      {others.length > 0 ? (
        <Section label="The party">
          <RowList>
            {others.map((c) => (
              <PartyRow key={c.id} character={c} />
            ))}
          </RowList>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * The DM's long rest for the whole party at once (features section 15): one
 * rest per character, sent as one gesture so one undo takes them all back.
 * A character at 0 HP cannot start a rest (shared/rules/rest.ts) and is
 * left as it is.
 */
function PartyLongRest(props: { characters: Character[] }) {
  const actions = useRoomActions();
  const [asking, setAsking] = useState(false);
  const resting = props.characters.filter((c) => c.actor.life === "alive" && c.actor.hp.cur >= 1);
  const left = props.characters.length - resting.length;
  if (!asking) {
    return (
      <Button size="sm" disabled={resting.length === 0} onClick={() => setAsking(true)}>
        Long rest for the party
      </Button>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.md,
        background: theme.color.surfaceRaised,
      }}
    >
      <Help>
        {resting.length === 1 ? "1 character gets" : `${resting.length} characters get`} all HP back, lose temporary HP and one Exhaustion level.
        {left > 0 ? ` ${left === 1 ? "1 character at 0 HP stays" : `${left} characters at 0 HP stay`} as they are.` : ""}
      </Help>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Button
          variant="primary"
          size="sm"
          style={{ flex: 1 }}
          onClick={() => {
            dispatchGesture(actions, resting.map((c) => ({ t: "actor.rest", target: { characterId: c.id }, kind: "long" })));
            setAsking(false);
          }}
        >
          Finish the long rest
        </Button>
        <Button size="sm" onClick={() => setAsking(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A character's disk in the panel: its portrait, or its initials as the board and the tracker draw them (lib/tokenView.ts). */
export function Portrait(props: { character: Pick<Character, "name" | "defaultImage">; size: number }) {
  const { character, size } = props;
  return <ImagePreview image={character.defaultImage} shape="circle" aspect={1} width={size} ring={theme.color.ally} initials={initials(character.name)} />;
}

function CharacterRow(props: { character: Character; open: boolean; onToggle(): void; close(): void; onAddCompanion(): void }) {
  const { character } = props;
  const members = useRoomView((s) => s.view?.members);
  const role = useRoomView((s) => s.you?.role);
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const hp = hpDisplay({ actor: character.actor, hpVisibility: undefined, fullAccess: true });
  const players = (character.ownerIds ?? []).map((id) => members?.[id]?.name).filter(Boolean).join(", ");
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {/* A disclosure that opens the character's card under it. */}
      <Row
        expanded={props.open}
        onClick={props.onToggle}
        leading={<Portrait character={character} size={32} />}
        title={character.name}
        detail={[hpText(hp) ? `HP ${hpText(hp)}` : null, players ? `played by ${players}` : role === "dm" ? "no player yet" : null].filter(Boolean).join(" · ")}
        trailing={<Icon name={props.open ? "chevronDown" : "chevronRight"} style={{ color: theme.color.textMuted }} />}
      />
      {props.open ? (
        <div style={{ padding: `0 ${theme.space(1)}px ${theme.space(2)}px` }}>
          {role === "dm" ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), paddingBottom: theme.space(2) }}>
              <Button
                size="sm"
                onClick={() => {
                  setPending(scope, { kind: "character", characterId: character.id, name: character.name });
                  ui.setTool(PLACE_TOOL_ID);
                  props.close();
                }}
              >
                Place a token
              </Button>
            </div>
          ) : (
            <PlaceMine character={character} close={props.close} />
          )}
          {/* Before the card: in play a player opens their card for companions more often than to edit stats (docs/design-v1-combat-flow.md 3.7.5). */}
          <CharacterCompanions character={character} canAdd onAdd={props.onAddCompanion} close={props.close} />
          <CharacterCard character={character} />
          {role === "dm" ? (
            <Section label="Remove">
              <Help>Deleting the character also removes every token of it, on every scene.</Help>
              <ConfirmButton confirm="Tap again to delete" onConfirm={() => actions.dispatch({ t: "character.delete", characterId: character.id })}>
                Delete {character.name}
              </ConfirmButton>
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The token a player puts down for a character of theirs: in the middle of the map they are looking at. */
function myToken(scope: RoomScope, input: Omit<Parameters<typeof playerToken>[0], "center"> & { view: Pick<RoomState, "buildChunks"> }): TokenInput | null {
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
  if (onScene(view, character.id, scene.id)) return <Help style={{ paddingBottom: theme.space(2) }}>{character.name} is on the map.</Help>;
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

/** Another player's character, as far as this player's projection shows it. */
function PartyRow(props: { character: Character }) {
  const { character } = props;
  const hp = hpDisplay({ actor: character.actor, hpVisibility: undefined, fullAccess: false });
  const effects = character.actor.effects ?? [];
  return (
    <Row
      leading={<Portrait character={character} size={32} />}
      title={character.name}
      detail={hpText(hp) || undefined}
      trailing={
        effects.length > 0 ? (
          // Wraps under itself past five badges, so a long list of conditions never squeezes the name to nothing.
          <span style={{ display: "flex", flexWrap: "wrap", gap: theme.space(0.5), justifyContent: "flex-end", maxWidth: theme.space(30) }}>
            {effects.map((e) => (
              <EffectIcon key={e.id} effect={e} size={20} />
            ))}
          </span>
        ) : undefined
      }
    />
  );
}

/**
 * The quick entry for a new PC: enough for the table, and the player fills
 * in the rest of the card. The DM picks who plays it. A player making their
 * own (`owner`) plays it alone, and "Create and place" puts it straight on
 * the map they are looking at.
 */
function NewCharacter(props: { onDone(id: string | null): void; close(): void; owner?: string }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const view = useRoomView((s) => s.view);
  const members = useRoomView((s) => s.view?.members);
  const players = Object.values(members ?? {}).filter((m): m is Member => !!m && m.kind === "player");
  const [name, setName] = useState("");
  const [owners, setOwners] = useState<string[]>(props.owner ? [props.owner] : []);
  const [size, setSize] = useState<CreatureSize>("medium");
  const [hpMax, setHpMax] = useState(10);
  const [ac, setAc] = useState(12);
  const [walk, setWalk] = useState(30);
  const [initBonus, setInitBonus] = useState(0);
  const [pp, setPp] = useState(10);
  const [image, setImage] = useState<ImageRef | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = (placeAfter: boolean) => {
    if (!name.trim()) {
      setError("Give the character a name.");
      return;
    }
    const id = actions.newId();
    const character = newCharacter({
      id,
      name: name.trim(),
      ownerIds: owners,
      size,
      hpMax,
      ac,
      walk,
      initBonus,
      passivePerception: pp,
      ...(image ? { defaultImage: image } : {}),
    });
    if (actions.dispatch({ t: "character.create", character }) === null) return;
    if (placeAfter && props.owner) {
      const scene = view?.meta.playerSceneId ? view.scenes[view.meta.playerSceneId] : undefined;
      // The view already holds the new character, as the op is applied at once on this device.
      const latest = view && scene ? { ...view, characters: { ...view.characters, [id]: { ...character, rev: 0 } } } : null;
      const token = latest && scene ? myToken(scope, { view: latest, scene, character, memberId: props.owner, id: actions.newId() }) : null;
      if (token && actions.dispatch({ t: "token.create", token }) !== null) ui.select(token.id);
      props.close();
    } else if (placeAfter) {
      setPending(scope, { kind: "character", characterId: id, name: character.name });
      ui.setTool(PLACE_TOOL_ID);
      props.close();
    }
    props.onDone(id);
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <h3 style={{ margin: 0, flex: 1, fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>New character</h3>
        <Button size="sm" onClick={() => props.onDone(null)}>
          Cancel
        </Button>
      </div>
      <ImageField value={image ?? undefined} onChange={setImage} shape="circle" aspect={1} canEdit ring={theme.color.ally} />
      <FieldRow label="Name">
        <Input aria-label="Name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Thorn" error={error !== null} style={{ flex: 1 }} />
      </FieldRow>
      <FieldRow label="Size">
        <Select aria-label="Size" value={size} onChange={(e) => setSize(e.target.value as CreatureSize)} style={{ flex: 1, maxWidth: "100%" }}>
          {SIZE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </FieldRow>
      <FieldRow label="Max HP">
        <NumberField label="Max HP" value={hpMax} min={1} max={100_000} onCommit={(n) => n !== null && setHpMax(n)} />
      </FieldRow>
      <FieldRow label="Armor Class">
        <NumberField label="Armor Class" value={ac} min={0} max={100} onCommit={(n) => n !== null && setAc(n)} />
      </FieldRow>
      <FieldRow label="Speed">
        <NumberField label="Speed" value={walk} min={0} max={1000} onCommit={(n) => n !== null && setWalk(n)} />
        <span style={{ color: theme.color.textMuted }}>ft</span>
      </FieldRow>
      <FieldRow label="Initiative bonus">
        <NumberField label="Initiative bonus" value={initBonus} min={-20} max={40} onCommit={(n) => n !== null && setInitBonus(n)} />
      </FieldRow>
      <FieldRow label="Passive Perception">
        <NumberField label="Passive Perception" value={pp} min={0} max={60} onCommit={(n) => n !== null && setPp(n)} />
      </FieldRow>
      {props.owner ? (
        <Help>You play this character. The DM can still change it.</Help>
      ) : (
        <Section label="Played by">
          {players.length === 0 ? <Help>No players have joined yet. You can pick one later.</Help> : null}
          <div>
            {players.map((m) => (
              <Checkbox
                key={m.id}
                checked={owners.includes(m.id)}
                onChange={(on) => setOwners((o) => (on ? [...o, m.id] : o.filter((id) => id !== m.id)))}
                label={m.name}
              />
            ))}
          </div>
        </Section>
      )}
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button variant="primary" size="sm" style={{ flex: 1 }} onClick={() => create(true)}>
          Create and place
        </Button>
        <Button size="sm" style={{ flex: 1 }} onClick={() => create(false)}>
          Create
        </Button>
      </div>
    </div>
  );
}
