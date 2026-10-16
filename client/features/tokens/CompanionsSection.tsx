import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { Character, CompanionTurn, CreatureSize, Token } from "#shared/model.ts";
import { playersToken } from "#shared/project.ts";
import type { ClientOp, TokenPatch } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorText, Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Spinner } from "../../components/Loading.tsx";
import { Help, Section as PanelSection } from "../../components/Panel.tsx";
import { Row, RowList } from "../../components/Row.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { layoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { panAnchor, requestPan } from "../encounter/pan.ts";
import { useSend } from "../encounter/hooks.ts";
import { ImageField } from "../images/ImageField.tsx";
import { ImagePreview } from "../images/IconDisk.tsx";
import { currentStageCamera } from "../scenes/stageCamera.ts";
import { displayName, footprint } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { initials } from "../../lib/tokenView.ts";
import { useRoomScope } from "../../state/scope.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import type { TokenAccess } from "./access.ts";
import { SIZE_OPTIONS } from "./CharacterCard.tsx";
import {
  NEW_COMPANION,
  companionInput,
  companionWhat,
  companionsOf,
  dmPlacement,
  draftError,
  draftWith,
  lateCompanionText,
  linkPatch,
  makeCompanionPatch,
  playerPlacement,
  turnChoices,
  turnLabel,
  type CompanionDraft,
  type CompanionWhat,
} from "./companions.ts";
import { FieldRow, NumberField, Section, Select } from "./ui.tsx";

/**
 * Companions in the interface (docs/design-v1-combat-flow.md 3.6.3, 3.6.9
 * and 3.7.5): the list and "Add a companion" in a character's card, the
 * form that replaces the Characters panel, the Companion section of a
 * companion's token panel, and the DM's "Make a companion" in Token
 * settings. Every change of what a companion is waits for the server
 * (shared/reads.ts), so each control shows busy until it answers.
 */

const WHAT_OPTIONS: { value: CompanionWhat; label: string }[] = [
  { value: "creature", label: "A creature" },
  { value: "effect", label: "An effect" },
];

/** A companion's picture: its token's image, or its initials, square for an effect as the map draws it. */
function CompanionPortrait(props: { token: Token; size: number }) {
  const fp = footprint(props.token);
  return (
    <ImagePreview
      image={props.token.image}
      shape={props.token.kind === "object" ? "square" : "circle"}
      aspect={fp.w / fp.h}
      width={props.size}
      ring={theme.color.ally}
      initials={initials(displayName(props.token))}
    />
  );
}

/**
 * The Companions section of a character's open card, after "Place my
 * token" and before the card itself: in play a player opens their card
 * more often for companions than to edit stats. It lists the companions on
 * the scene this device holds, each a button that shows it on the map with
 * its bar, as a party bar tap does.
 */
export function CharacterCompanions(props: { character: Character; canAdd: boolean; onAdd(): void; close(): void }) {
  const tokens = useRoomView((s) => s.view?.tokens);
  const ui = useRoomUi();
  const scope = useRoomScope();
  const list = tokens ? companionsOf({ tokens }, props.character.id) : [];
  if (list.length === 0 && !props.canAdd) return null;
  const show = (token: Token) => {
    ui.tap(token.id);
    props.close();
    const fp = footprint(token);
    requestPan(scope, {
      sceneId: token.sceneId,
      x: token.x + fp.w / 2,
      y: token.y + fp.h / 2,
      anchor: panAnchor(layoutSize(window, uiScale()), theme.layout.wideMinWidth, false),
    });
  };
  return (
    <PanelSection label="Companions" divider={false}>
      {list.length > 0 ? (
        <RowList label={`${props.character.name}'s companions`}>
          {list.map((t) => (
            <Row
              key={t.id}
              leading={<CompanionPortrait token={t} size={28} />}
              title={displayName(t)}
              detail={t.companion ? turnLabel(props.character.name, t.companion.turn) : undefined}
              label={`${displayName(t)}. Show it on the map with its actions`}
              onClick={() => show(t)}
              trailing={<Icon name="chevronRight" style={{ color: theme.color.textMuted }} />}
            />
          ))}
        </RowList>
      ) : null}
      {props.canAdd ? (
        <div style={{ display: "flex" }}>
          <Button size="sm" onClick={props.onAdd}>
            Add a companion
          </Button>
        </div>
      ) : null}
    </PanelSection>
  );
}

/**
 * The form a character's "Add a companion" opens in the panel's place, as
 * New character does. A player's companion goes only next to the
 * character's token on the players' scene, at the first free spot within
 * 5 ft with a clear line, which the server checks again; the button says
 * why when there is none. The DM's goes on the scene in view, beside the
 * character's token when it stands there, else in the middle of the view.
 * It is busy until the server answers, and a refusal keeps the form open
 * with the reason.
 */
export function CompanionForm(props: {
  character: Character;
  /** Whether the panel holding the form is on screen (PanelProps.shown). */
  shown: boolean;
  close(): void;
  onDone(): void;
}) {
  const { character } = props;
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const dm = useRoomView((s) => s.you?.role === "dm");
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const [draft, setDraft] = useState<CompanionDraft>(NEW_COMPANION);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  /*
   * An answer moves the screen only while this form is still open and in
   * sight. After Cancel, or with another panel opened since, a late one may
   * not select the new token or close what the user has moved on to, and
   * Cancel cannot take back an op the server may already hold.
   */
  const mounted = useRef(true);
  const inSight = useRef(props.shown);
  inSight.current = props.shown;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const set = (patch: Partial<Omit<CompanionDraft, "turnPicked">>) => {
    setDraft((d) => draftWith(d, patch));
    setError(null);
  };
  const name = character.name;
  const live = currentStageCamera(scope);
  const scene = sceneId ? view?.scenes[sceneId] : undefined;
  const center = live
    ? { x: (live.viewport.width / 2 - live.camera.x) / live.camera.scale, y: (live.viewport.height / 2 - live.camera.y) / live.camera.scale }
    : { x: (scene?.bounds.w ?? 0) / 2, y: (scene?.bounds.h ?? 0) / 2 };
  const placement = !view ? null : dm ? dmPlacement(view, character, { size: draft.size }, { sceneId, center }) : playerPlacement(view, character, { size: draft.size });
  const choices = turnChoices(name, draft.what);
  const chosen = choices.find((c) => c.value === draft.turn) ?? choices[0]!;
  const besideHere = dm && sceneId !== null && Object.values(view?.tokens ?? {}).some((t) => t?.sceneId === sceneId && "ref" in t.actor && t.actor.ref === character.id);
  const where = !placement?.ok ? placement?.reason : dm && !besideHere ? "Goes in the middle of your view." : `Goes next to ${name} on the map.`;

  const add = () => {
    const problem = draftError(draft);
    if (problem) {
      setError(problem);
      return;
    }
    if (!placement?.ok || waiting) return;
    const id = actions.newId();
    const op: ClientOp = { t: "token.create", token: companionInput(draft, { id, sceneId: placement.sceneId, x: placement.x, y: placement.y, elevation: placement.elevation }, character) };
    const sentName = op.token.name;
    const onAnswer = (answer: OpAnswer, refusal?: OpRefusal) => {
      if (!mounted.current || !inSight.current) {
        const text = lateCompanionText(sentName, answer, refusal);
        if (text) ui.notify(text, "error");
        if (!mounted.current) return;
        // Still open out of sight: done once added, else showing why for when the user comes back.
        setWaiting(false);
        if (answer === "taken") props.onDone();
        else setError(answer === "refused" && refusal?.message ? capitalized(refusal.message) : "It may not have been added. Check the map before trying again.");
        return;
      }
      setWaiting(false);
      if (answer === "taken") {
        // Selected with its bar open on the map, as a tap on it does, and the sheet gets out of the way so the player can drag it on.
        ui.tap(id);
        props.close();
        props.onDone();
      } else if (answer === "refused") setError(refusal?.message ? capitalized(refusal.message) : "The server refused it.");
      else setError("It may not have been added. Check the map before trying again.");
    };
    if (actions.dispatch(op, { onAnswer, quiet: true }) !== null) setWaiting(true);
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <h3 style={{ margin: 0, flex: 1, fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>Add a companion for {name}</h3>
        <Button size="sm" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
      <FieldRow label="Name">
        <Input aria-label="Name" value={draft.name} maxLength={80} placeholder="Wildfire Spirit" error={error !== null && !draft.name.trim()} onChange={(e) => set({ name: e.target.value })} style={{ flex: 1 }} />
      </FieldRow>
      <FieldRow label="It is">
        <Segmented<CompanionWhat> label="What it is" value={draft.what} options={WHAT_OPTIONS} onChange={(what) => set({ what })} />
      </FieldRow>
      <FieldRow label="Turn">
        <Select<CompanionTurn> label="Turn" value={chosen.value} options={choices} onChange={(turn) => set({ turn })} />
      </FieldRow>
      <Help>{chosen.help}</Help>
      <FieldRow label="Size">
        <Select<CreatureSize> label="Size" value={draft.size} options={SIZE_OPTIONS.filter((o) => o.value !== "custom")} onChange={(size) => set({ size })} />
      </FieldRow>
      {draft.what === "creature" ? (
        <>
          <FieldRow label="HP">
            <NumberField label="HP" value={draft.hp ?? undefined} min={1} max={100_000} nullable placeholder="15" onCommit={(hp) => set({ hp })} />
          </FieldRow>
          <FieldRow label="AC">
            <NumberField label="AC" value={draft.ac ?? undefined} min={0} max={100} nullable placeholder="13" onCommit={(ac) => set({ ac })} />
          </FieldRow>
        </>
      ) : null}
      <ImageField
        value={draft.image ?? undefined}
        onChange={(image) => set({ image })}
        shape={draft.what === "effect" ? "square" : "circle"}
        aspect={1}
        canEdit
        ring={theme.color.ally}
        initials={initials(draft.name || "?")}
      />
      <ErrorText>{error}</ErrorText>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button variant="primary" size="sm" style={{ flex: 1 }} busy={waiting} disabled={!placement?.ok} aria-describedby="companion-where" onClick={add}>
          {waiting ? "Adding…" : "Add and place"}
        </Button>
        <Button size="sm" style={{ flex: 1 }} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
      {where ? <Help id="companion-where">{where}</Help> : null}
    </div>
  );
}

/** A refusal's words as a line of the form. */
function capitalized(text: string): string {
  return text.length > 0 ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/**
 * The Companion section of a companion's token panel, for the DM and its
 * owners (3.6.9): whose it is, what it is and its turn. A player's change
 * of what it is or its turn waits for the server, busy until it answers.
 * Making it an effect waits until it acts on its character's turn, since
 * an effect takes no turn of its own.
 */
export function CompanionSection(props: {
  token: Token;
  access: TokenAccess;
  /** The token panel's fold for this section, given the summary to show beside its label while folded (docs/design-v1-token-panel.md 3.5). */
  fold?(summary: ReactNode): ComponentProps<typeof Section>["fold"];
}) {
  const { token, access } = props;
  const companion = token.companion;
  const characters = useRoomView((s) => s.view?.characters);
  const relink = useSend();
  const kind = useSend();
  const detach = useSend();
  if (!companion || !access.companion) return null;
  const owner = characters?.[companion.of];
  const name = owner?.name ?? "its character";
  const what = companionWhat(token.kind);
  const choices = turnChoices(name, what);
  const chosen = choices.find((c) => c.value === companion.turn) ?? choices[0]!;
  const send = (patch: TokenPatch) => relink.send({ t: "token.update", tokenId: token.id, patch });
  const list = Object.values(characters ?? {})
    .filter((c): c is Character => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
  // Folded, the section names its character beside its label, as Owners names its players.
  const summary = <span style={{ flex: "0 1 auto", minWidth: 0, color: theme.color.textMuted, fontSize: theme.font.small, overflowWrap: "anywhere" }}>{name}</span>;
  return (
    <Section title="Companion" fold={props.fold?.(summary)}>
      {access.dm ? (
        <FieldRow label="Belongs to">
          <Select<string>
            label="Belongs to"
            value={companion.of}
            disabled={relink.waiting}
            options={list.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(of) => send(linkPatch(companion, { of }))}
          />
        </FieldRow>
      ) : (
        <Help>
          Belongs to {name}. Whoever plays {name} controls it.
        </Help>
      )}
      <FieldRow label="It is">
        <Segmented<CompanionWhat>
          label="What it is"
          value={what}
          disabled={kind.waiting}
          options={WHAT_OPTIONS.map((o) => (o.value === "effect" && companion.turn === "own" ? { ...o, disabled: true } : o))}
          onChange={(next) => next !== what && kind.send({ t: "token.update", tokenId: token.id, patch: { kind: next === "effect" ? "object" : "npc" } })}
        />
      </FieldRow>
      {companion.turn === "own" ? <Help>Choose one of {name}'s turns first.</Help> : null}
      <FieldRow label="Turn">
        <Select<CompanionTurn> label="Turn" value={chosen.value} disabled={relink.waiting} options={choices} onChange={(turn) => send(linkPatch(companion, { turn }))} />
      </FieldRow>
      <Help>{chosen.help}</Help>
      {relink.waiting || kind.waiting ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), color: theme.color.textMuted, fontSize: theme.font.small }}>
          <Spinner label="Saving" /> Saving…
        </span>
      ) : null}
      {access.dm ? (
        <div style={{ display: "flex" }}>
          <Button size="sm" busy={detach.waiting} onClick={() => detach.send({ t: "token.update", tokenId: token.id, patch: { companion: null } })}>
            Stop being a companion
          </Button>
        </div>
      ) : null}
    </Section>
  );
}

/** The empty choice "Belongs to" starts at, which no character id can be. */
const NO_CHARACTER = "";

/**
 * The DM's "Make a companion" in Token settings, on any token that is not
 * a PC, has stats of its own and is not yet a companion (3.6.9): it opens
 * whose it is and its turn in place, with no character chosen and the turn
 * listed under its character (docs/design-v1-token-panel.md 3.8), and
 * sends nothing until its own button, which waits for a character. Cancel
 * starts the form again from there. The one update also gives a hostile
 * token the ally ring.
 */
export function MakeCompanion(props: { token: Token }) {
  const { token } = props;
  const characters = useRoomView((s) => s.view?.characters);
  const [open, setOpen] = useState(false);
  const list = Object.values(characters ?? {})
    .filter((c): c is Character => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));
  const [of, setOf] = useState<string>(NO_CHARACTER);
  const [turn, setTurn] = useState<CompanionTurn>("shared");
  const make = useSend();
  // A companion has stats of its own, so a token that reads a character's cannot be one.
  if (token.kind === "pc" || token.companion || "ref" in token.actor) return null;
  if (!open) {
    return (
      <div style={{ display: "flex" }}>
        <Button size="sm" onClick={() => setOpen(true)}>
          Make a companion
        </Button>
      </div>
    );
  }
  if (list.length === 0) return <Help>A companion belongs to a character. Make a character first.</Help>;
  const character = list.find((c) => c.id === of);
  const choices = turnChoices(character?.name ?? "its character", companionWhat(token.kind));
  const chosen = choices.find((c) => c.value === turn) ?? choices[0]!;
  const cancel = () => {
    setOpen(false);
    setOf(NO_CHARACTER);
    setTurn("shared");
  };
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <FieldRow label="Belongs to">
        <Select<string>
          label="Belongs to"
          value={character ? character.id : NO_CHARACTER}
          options={[...(character ? [] : [{ value: NO_CHARACTER, label: "Choose a character" }]), ...list.map((c) => ({ value: c.id, label: c.name }))]}
          onChange={setOf}
        />
      </FieldRow>
      <FieldRow label="Turn">
        <Select<CompanionTurn> label="Turn" value={chosen.value} options={choices} onChange={setTurn} />
      </FieldRow>
      <Help>{chosen.help}</Help>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Button
          size="sm"
          variant="primary"
          busy={make.waiting}
          disabled={!character}
          onClick={() => character && make.send({ t: "token.update", tokenId: token.id, patch: makeCompanionPatch(token, character.id, chosen.value) })}
        >
          Make a companion
        </Button>
        <Button size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The Owners section's line for a companion, whose owners are its character's (3.6.9). */
export function CompanionOwners(props: { token: Token }) {
  const characters = useRoomView((s) => s.view?.characters);
  const members = useRoomView((s) => s.view?.members);
  const companion = props.token.companion;
  if (!companion) return null;
  const character = characters?.[companion.of];
  const players = (character?.ownerIds ?? []).map((id) => members?.[id]?.name).filter(Boolean);
  const name = character?.name ?? "its character";
  return (
    <Help>
      Played by whoever plays {name}: {players.length > 0 ? players.join(", ") : "no one yet"}.
    </Help>
  );
}

/**
 * Whether a token's HP follows the party's rule rather than its own
 * setting: a creature companion a player plays (docs/design-v1-combat-flow.md
 * 3.6.5), whose "Players see HP as" reads so in place of the Select.
 */
export function followsPartyHp(view: Parameters<typeof playersToken>[0] | null | undefined, token: Token): boolean {
  return !!view && token.companion !== undefined && token.kind !== "object" && playersToken(view, token);
}
