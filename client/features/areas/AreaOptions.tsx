import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { AreaShape, AreaTemplate, AreaTrigger } from "#shared/model.ts";
import { AREA_MAX_FT, AREA_MIN_FT, canPitch, emanationFootprint, MAX_PITCH, pitchOf, type AreaTemplateInput } from "#shared/rules/aoe.ts";
import { boxDistanceFt, pointCellBox, tokenCellBox } from "#shared/rules/distance.ts";
import { displayName } from "../../lib/scene.ts";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { Popover, usePopover } from "../../components/Popover.tsx";
import { dismissedBy } from "../../components/popoverRules.ts";
import { MEMBER_COLORS, theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import {
  ChoiceTiles,
  OptButton,
  OptInput,
  OptionsStrip,
  OptSegmented,
  OptSwatches,
  PickCloses,
  Stepper,
  useOpenInSlot,
  usePopoverFrame,
  useSlotPlace,
  ValueChip,
  type Slot,
  type StripLine,
} from "../measure/controls.tsx";
import { POPOVER_MIN } from "../../pages/optionsLayout.ts";
import { castFrom, choiceOf, draftCaster, fromOffers, withoutDeparted, type AreaCreature } from "./caster.ts";
import { caughtTokens, contextFrom, inAreaEntries, inAreaText } from "./coverage.ts";
import { FromControl, NO_CREATURE } from "./FromControl.tsx";
import { areaTitle, shapeName, SHAPES } from "./labels.ts";
import {
  aimText,
  AREA_TRIGGERS,
  clampPitch,
  draftFromTemplate,
  liveOrigin,
  normalizeTriggers,
  usesFrom,
  withShape,
  type AreaDraft,
  type SnapMode,
} from "./placement.ts";
import { placementHint, presetDraft, searchAreaSpells } from "./presets.ts";
import {
  canEdit,
  cancelDraft,
  castsYours,
  currentTemplate,
  deleteTemplate,
  liveContext,
  openDamage,
  placeDraft,
  resolvedChoice,
  samplesNow,
  select,
  setChoice,
  setDraft,
  setShared,
  startDraft,
  updateTemplate,
  useAreaScope,
  yourCreatures,
  type AreaEnv,
  type AreaToolState,
} from "./store.ts";
import { useLiveTokens } from "./useLiveTokens.ts";

/**
 * The area tool's options (docs/design-v1-tool-options.md 9.3): its line
 * is the hint, or what the area catches, the "In area" list (features
 * section 9), names as this viewer sees them with allies marked,
 * recomputed as tokens move. Its row holds who the area comes from (the
 * From control, docs/design-v1-area-from-character.md), the shape, Place,
 * Cancel and the rest by priority, and its less used settings are always
 * in ⋯ under "More area options". The spell search and Size wait in the
 * shape chip's popover when the row has no room for them.
 */

const SNAPS: readonly { value: SnapMode; label: string }[] = [
  { value: "15", label: "15°" },
  { value: "45", label: "45°" },
  { value: "free", label: "Free" },
];

const SHAPE_GLYPHS: Record<AreaShape, IconName> = {
  cone: "areaCone",
  sphere: "areaSphere",
  cylinder: "areaCylinder",
  cube: "areaCube",
  line: "areaLine",
  emanation: "areaEmanation",
};

const SIZES = { words: (ft: number) => `${ft.toLocaleString("en-US")} ft`, all: [`${AREA_MIN_FT} ft`, `${AREA_MAX_FT.toLocaleString("en-US")} ft`] } as const;

const MORE = "More area options";

export function AreaOptions(props: { role: "dm" | "player" }) {
  const area = useAreaScope();
  const st = useStore(area.store);
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const youId = useRoomView((s) => s.you?.memberId);
  const actions = useRoomActions();
  const scene = sceneId ? view?.scenes[sceneId] : undefined;
  if (!view || !scene || !youId) return null;
  const env: AreaEnv = { actions, view, scene, role: props.role, youId, area };
  if (st.draft) return <DraftOptions env={env} st={st} draft={st.draft} />;
  const selected = st.selectedId ? view.templates[st.selectedId] : undefined;
  if (selected && selected.sceneId === scene.id) return <SelectedOptions env={env} st={st} template={selected} />;
  return <IdleOptions env={env} st={st} />;
}

/** What the area catches, as the line's reading: its title in bold, then the "In area" list and what follows it. */
function InArea(props: { env: AreaEnv; t: AreaTemplateInput; moving: boolean; title: string; extra?: ReactNode }) {
  const { env, t } = props;
  // Tokens other members are dragging count where they would drop.
  const live = useLiveTokens();
  const ctx = contextFrom({ tokens: live.tokens, buildChunks: env.view.buildChunks, settings: env.view.meta.settings }, env.scene, samplesNow(props.moving || live.moving));
  const ids = caughtTokens(t, ctx, env.scene.id);
  const entries = inAreaEntries(ids, live.tokens, env.view.characters);
  return (
    <>
      <strong>{props.title}</strong>
      <span style={{ color: theme.color.textMuted }}> · In area{entries.length ? ` (${entries.length})` : ""}: </span>
      {inAreaText(entries)}
      {props.extra}
    </>
  );
}

function inAreaLine(props: Parameters<typeof InArea>[0]): StripLine {
  return { tone: "reading", content: <InArea {...props} /> };
}

/**
 * The spell search. In the row it is a flexible field whose matches show
 * in a "Spells" popover anchored to it while it has focus and text. In
 * the shape chip's popover, or in ⋯, they show under it. Enter applies
 * the first match.
 *
 * Any close the person makes (Escape, Back, Tab or Shift+Tab out, a
 * press elsewhere, components/popoverRules.ts dismissedBy) dismisses the
 * results, and they stay closed while the field keeps its focus and its
 * words, until the words change, the field is pressed or Down asks for
 * them. Otherwise the focused field with text would open them again at
 * once.
 */
function SpellField(props: { env: AreaEnv; st: AreaToolState; base: () => AreaDraft }) {
  const { env, st } = props;
  const place = useSlotPlace();
  const inRow = place?.at === "row";
  const [dismissed, setDismissed] = useState(false);
  const results = usePopover({
    kind: "dialog",
    onClose: (reason) => {
      if (dismissedBy(reason)) setDismissed(true);
    },
  });
  const [focused, setFocused] = useState(false);
  const typed = st.query.trim() !== "";
  const { show, close, open } = results;
  useOpenInSlot(open);
  useEffect(() => {
    if (inRow && focused && typed && !open && !dismissed) show({ by: "pointer", from: "first" });
    else if (!typed && open) close("state");
  }, [inRow, focused, typed, open, dismissed, show, close]);
  const apply = (name: string) => {
    applySpell(env, props.base(), name);
    close("pick");
  };
  const field = (
    <OptInput
      ref={inRow ? results.anchorProps.ref : undefined}
      label="Spell"
      placeholder="Spell, e.g. fireball"
      value={st.query}
      width={170}
      onChange={(query) => {
        setDismissed(false);
        env.area.store.setState({ query });
      }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onReopen={() => setDismissed(false)}
      onEnter={() => {
        const first = searchAreaSpells(st.query, 1)[0];
        if (first) apply(first.name);
      }}
      popup={inRow ? { expanded: open, controls: results.anchorProps["aria-controls"] } : undefined}
    />
  );
  if (!inRow) {
    return (
      <div style={{ display: "grid", gap: theme.space(1) }}>
        {field}
        {typed ? <SpellResults query={st.query} onPick={apply} /> : null}
      </div>
    );
  }
  return (
    <>
      {field}
      <SpellsPopover handle={results} query={st.query} onPick={apply} />
    </>
  );
}

function SpellsPopover(props: { handle: ReturnType<typeof usePopover>; query: string; onPick(name: string): void }) {
  const frame = usePopoverFrame();
  return (
    <Popover handle={props.handle} side="above" bound={frame.bound} rise={frame.rise} gap={frame.gap} minHeight={POPOVER_MIN} title="Spells">
      <SpellResults query={props.query} onPick={props.onPick} />
    </Popover>
  );
}

/**
 * A spell picked while placing takes the area's caster, or none while From
 * is off, and never falls back to the saved choice. While idle its draft is
 * a new area, which starts from the saved choice (startDraft).
 */
function applySpell(env: AreaEnv, base: AreaDraft, name: string): void {
  const spell = searchAreaSpells(name, 1)[0];
  if (!spell) return;
  setDraft(env, presetDraft(spell, base, draftCaster(base) ?? undefined));
  env.area.store.setState({ query: "" });
}

function SpellResults(props: { query: string; onPick(name: string): void }) {
  const results = searchAreaSpells(props.query, 8);
  return (
    <div role="group" aria-label="Spells" style={{ display: "grid", gap: theme.space(1) }}>
      {results.length === 0 ? <span style={{ color: theme.color.textMuted, fontSize: theme.font.body14 }}>No area spell by that name.</span> : null}
      {results.map((s) => (
        <OptButton key={s.srdId} onClick={() => props.onPick(s.name)}>
          {s.name}
          <span style={{ fontWeight: theme.weight.regular, color: theme.color.textMuted }}>
            {" "}
            {s.size} ft {shapeName(s.shape).toLowerCase()}
          </span>
        </OptButton>
      ))}
    </div>
  );
}

/**
 * The shape chip, "Shape: Sphere", with the shapes as tiles. Its glyph
 * shows where the row has room, and alone where it has little. While the
 * size waits in its popover, it reads "Sphere 20 ft" where the row holds it.
 */
function ShapeChip(props: { value: AreaShape; size?: number; onChange(shape: AreaShape): void }) {
  return (
    <ValueChip
      label="Shape"
      kind="choice"
      value={props.value}
      options={SHAPES.map((s) => ({ key: s.value, words: s.label, glyph: <Icon name={SHAPE_GLYPHS[s.value]} /> }))}
      hosted={props.size !== undefined ? { words: SIZES.words(props.size), all: SIZES.all } : undefined}
    >
      <PickCloses>
        <ChoiceTiles<AreaShape> label="Shape" value={props.value} options={SHAPES.map((s) => ({ value: s.value, label: s.label, glyph: <Icon name={SHAPE_GLYPHS[s.value]} /> }))} onChange={props.onChange} />
      </PickCloses>
    </ValueChip>
  );
}

/** Degrees per tap when aiming a cone or line up or down. */
const AIM_STEP = 5;

/**
 * Aims a cone or line up or down (features section 9), so a cone can reach
 * a flier. The readout says "30° up" rather than a signed number, which
 * reads as a typo on a phone.
 */
function AimControl(props: { pitch: number; onChange(pitch: number): void }) {
  return (
    <Stepper
      label="Aim up or down"
      value={props.pitch}
      step={AIM_STEP}
      min={-MAX_PITCH}
      max={MAX_PITCH}
      format={aimText}
      less="Aim lower"
      more="Aim higher"
      icons={["chevronDown", "chevronUp"]}
      valueWidth={84}
      onChange={(pitch) => props.onChange(clampPitch(pitch))}
    />
  );
}

const TRIGGER_BUTTONS: Record<AreaTrigger, { label: string; hint: string }> = {
  enter: { label: "Enters", hint: "Remind when a creature enters it during a turn" },
  turnStart: { label: "Starts turn", hint: "Remind when a creature starts its turn in it" },
  turnEnd: { label: "Ends turn", hint: "Remind when a creature ends its turn in it" },
};

/**
 * When the log reminds the table that the area hits a creature again
 * (features section 9), under "Reminders" in ⋯. A spell preset sets them
 * where the spell says so, Spirit Guardians on entering and at the end of
 * a turn, and once a turn where the spell says "only once per turn". Once
 * a turn means nothing without a trigger, so it shows only with one.
 */
function triggerSlots(props: {
  value: readonly AreaTrigger[] | undefined;
  once: boolean;
  onChange(next: AreaTrigger[]): void;
  onOnce(next: boolean): void;
}): Slot[] {
  const on = normalizeTriggers(props.value);
  const group = MORE;
  const sub = "Reminders";
  return [
    ...AREA_TRIGGERS.map(
      (t): Slot => ({
        id: `remind-${t}`,
        priority: 9,
        always: true,
        group,
        sub,
        control: (
          <OptButton pressed={on.includes(t)} label={TRIGGER_BUTTONS[t].hint} onClick={() => props.onChange(on.includes(t) ? on.filter((x) => x !== t) : normalizeTriggers([...on, t]))}>
            {TRIGGER_BUTTONS[t].label}
          </OptButton>
        ),
      }),
    ),
    ...(on.length > 0
      ? [
          {
            id: "remind-once",
            priority: 9,
            always: true,
            group,
            sub,
            control: (
              <OptButton pressed={props.once} label="Remind about a creature once a turn, whichever comes first" onClick={() => props.onOnce(!props.once)}>
                Once a turn
              </OptButton>
            ),
          },
        ]
      : []),
  ];
}

/** ", aimed 30° up" after an area's name, or nothing when it is level. */
function aimSuffix(pitch: number): string {
  return pitch === 0 ? "" : `, aimed ${aimText(pitch)}`;
}

/** A slot always in ⋯ under "More area options". */
function more(id: string, control: ReactNode): Slot {
  return { id, priority: 9, always: true, group: MORE, control };
}

/** The idle line without a caster: today's taps. */
const IDLE_HINT = "Tap a token to cast from it, or tap the map. Tap an area on the map to pick it.";

/**
 * The From control's choice: while idle the saved choice, and while placing
 * the area's caster at once (3.4). Off and No caster, and a pick of one of
 * the player's creatures, set the saved choice too. A pick of someone
 * else's token, the area's own caster, does not.
 */
function pickFrom(env: AreaEnv, d: AreaDraft | null, offer: AreaCreature | null): void {
  if (d) setDraft(env, castFrom(d, offer?.tokenId ?? null, env.view.tokens, env.view.meta.settings.feetPerCell));
  if (offer === null) setChoice(env, "none");
  else if (offer.yours) setChoice(env, choiceOf(offer));
}

function IdleOptions(props: { env: AreaEnv; st: AreaToolState }) {
  const { env, st } = props;
  const base = () => startDraft(env, resolvedChoice(env));
  const creatures = yourCreatures(env);
  const resolved = resolvedChoice(env, creatures);
  const control = fromOffers({ creatures, draft: null, saved: resolved, view: env.view, sceneId: env.scene.id, you: { memberId: env.youId, role: env.role } });
  const casting = resolved !== null ? creatures.find((c) => c.tokenId === resolved) : undefined;
  const hint =
    control.form === "disabled"
      ? `${NO_CREATURE} ${IDLE_HINT}`
      : casting
        ? `Casting from ${casting.name}. Tap the map or a creature to aim or place it. Tap an area on the map to pick it.`
        : IDLE_HINT;
  return (
    <OptionsStrip
      tool="Area"
      line={{ tone: "hint", content: hint }}
      slots={[
        control.form !== "none" && { id: "from", priority: 1, compact: true, control: <FromControl control={control} onPick={(offer) => pickFrom(env, null, offer)} /> },
        { id: "shape", priority: 1, compact: true, glyph: true, control: <ShapeChip value={st.shape} onChange={(shape) => env.area.store.setState({ shape })} /> },
        { id: "spell", priority: 3, flex: theme.layout.options.field, home: "shape", control: <SpellField env={env} st={st} base={base} /> },
      ]}
    />
  );
}

function DraftOptions(props: { env: AreaEnv; st: AreaToolState; draft: AreaDraft }) {
  const { env, st } = props;
  // A creature the draft names that left the scene or was deleted goes from it, and nothing stands in for it (3.3).
  const d = withoutDeparted(props.draft, (id) => env.view.tokens[id]?.sceneId === env.scene.id);
  useLayoutEffect(() => {
    if (d !== props.draft) setDraft(env, d);
  });
  const t = currentTemplate(env, d);
  const fpc = env.view.meta.settings.feetPerCell;
  const set = (patch: Partial<AreaDraft>) => setDraft(env, { ...d, ...patch });
  const casterId = draftCaster(d);
  const caster = casterId ? env.view.tokens[casterId] : undefined;
  const creatures = yourCreatures(env);
  const control = fromOffers({ creatures, draft: d, saved: null, view: env.view, sceneId: env.scene.id, you: { memberId: env.youId, role: env.role } });

  let range: ReactNode = null;
  if (t && caster && !usesFrom(d.shape)) {
    const ft = boxDistanceFt(tokenCellBox(caster, fpc), pointCellBox(t.origin, fpc), env.view.meta.settings);
    const over = d.rangeFt !== undefined && ft > d.rangeFt;
    range = (
      <span style={{ color: over ? theme.color.warning : theme.color.textMuted }}>
        {" "}
        · {ft} ft from {displayName(caster)}
        {d.rangeFt !== undefined ? (over ? `, past its ${d.rangeFt} ft range` : ` of ${d.rangeFt} ft`) : ""}
      </span>
    );
  }
  const note = d.note ? <span style={{ color: theme.color.textMuted }}> · {d.note}</span> : null;
  const title = (d.spell ?? `${d.size} ft ${shapeName(d.shape).toLowerCase()}`) + (canPitch(d.shape) ? aimSuffix(clampPitch(d.pitch)) : "");
  const line: StripLine = t
    ? inAreaLine({ env, t, moving: st.moving, title, extra: <>{range}{note}</> })
    : {
        tone: "hint",
        content: (
          <>
            {st.pickCaster ? "Tap the caster." : `${caster ? `Cast by ${displayName(caster)}. ` : ""}${placementHint(d, castsYours(env, d, creatures))}`}
            {note}
          </>
        ),
      };

  return (
    <OptionsStrip
      tool="Area"
      line={line}
      task
      slots={[
        control.form !== "none" && { id: "from", priority: 1, compact: true, control: <FromControl control={control} onPick={(offer) => pickFrom(env, d, offer)} /> },
        { id: "shape", priority: 1, compact: true, glyph: true, hosts: "size", control: <ShapeChip value={d.shape} size={d.size} onChange={(shape) => setDraft(env, withShape(d, shape))} /> },
        { id: "size", priority: 3, home: "shape", control: <Stepper label="Size" unit="ft" value={d.size} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(size) => set({ size })} /> },
        {
          id: "place",
          priority: 1,
          control: (
            <OptButton tone="primary" disabled={!t} ends onClick={() => placeDraft(env)}>
              Place
            </OptButton>
          ),
        },
        {
          id: "shared",
          priority: 4,
          control: (
            // A fixed name that says what pressed means (docs/design-v1-visual.md 3.7).
            <OptButton pressed={st.shared} disabled={!t} label="Everyone sees this preview" onClick={() => setShared(env, !st.shared)}>
              Shared
            </OptButton>
          ),
        },
        {
          id: "cancel",
          priority: 2,
          control: (
            <OptButton ends onClick={() => cancelDraft(env)}>
              Cancel
            </OptButton>
          ),
        },
        { id: "spell", priority: 5, flex: theme.layout.options.field, home: "shape", control: <SpellField env={env} st={st} base={() => d} /> },
        more("snap", <OptSegmented label="Rotation snap" value={st.snap} options={SNAPS} onChange={(snap) => env.area.store.setState({ snap })} />),
        canPitch(d.shape) && more("aim", <AimControl pitch={clampPitch(d.pitch)} onChange={(pitch) => set({ pitch })} />),
        d.shape === "line" && more("width", <Stepper label="Width" unit="ft" value={d.width} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(width) => set({ width })} />),
        d.shape === "cylinder" && more("height", <Stepper label="Height" unit="ft" value={d.height} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(height) => set({ height })} />),
        d.shape === "cylinder" &&
          more(
            "pointOn",
            <OptSegmented
              label="Point on"
              value={d.anchor}
              options={[
                { value: "bottom", label: "Bottom" },
                { value: "top", label: "Top" },
              ]}
              onChange={(anchor) => set({ anchor })}
            />,
          ),
        d.shape === "cube" &&
          d.fromId &&
          more(
            "cubeReaches",
            <OptSegmented
              label="Cube reaches"
              value={d.faceU > 0 ? "left" : d.faceU < 0 ? "right" : "center"}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Center" },
                { value: "right", label: "Right" },
              ]}
              onChange={(v) => set({ faceU: v === "left" ? 0.5 : v === "right" ? -0.5 : 0 })}
            />,
          ),
        d.point && !d.fromId && more("elevation", <Stepper label="Elevation" unit="ft" value={d.point.z} step={5} min={-1000} max={1000} onChange={(z) => set({ point: { ...d.point!, z } })} />),
        d.shape !== "sphere" &&
          d.shape !== "cylinder" &&
          more(
            "includes",
            <OptButton pressed={d.includeOrigin} onClick={() => set({ includeOrigin: !d.includeOrigin })}>
              {d.targetsOther ? `Includes ${d.targetName ?? "target"}` : "Includes caster"}
            </OptButton>,
          ),
        d.shape === "emanation" &&
          d.fromId &&
          !d.targetsOther &&
          more(
            "attached",
            <OptButton pressed={d.attached} onClick={() => set({ attached: !d.attached })}>
              Moves with token
            </OptButton>,
          ),
        more(
          "caster",
          <OptButton pressed={st.pickCaster} onClick={() => env.area.store.setState({ pickCaster: !st.pickCaster })}>
            {caster ? `Caster: ${displayName(caster)}` : "Set caster"}
          </OptButton>,
        ),
        ...triggerSlots({ value: d.triggers, once: d.oncePerTurn, onChange: (triggers) => set({ triggers }), onOnce: (oncePerTurn) => set({ oncePerTurn }) }),
        more("color", <OptSwatches label="Color" value={d.color} options={MEMBER_COLORS} onChange={(color) => set({ color })} />),
        env.role === "dm" &&
          more(
            "dmOnly",
            <OptButton pressed={d.visibility === "dm"} onClick={() => set({ visibility: d.visibility === "dm" ? "all" : "dm" })}>
              DM only
            </OptButton>,
          ),
      ]}
    />
  );
}

function SelectedOptions(props: { env: AreaEnv; st: AreaToolState; template: AreaTemplate }) {
  const { env, st, template } = props;
  const ui = useRoomUi();
  const t = st.live ? ({ ...template, ...st.live } as AreaTemplate) : template;
  const editable = canEdit(env, template);
  const update = (patch: Parameters<typeof updateTemplate>[2]) => updateTemplate(env, template.id, patch);
  const caster = t.casterId ? env.view.tokens[t.casterId] : undefined;
  const fpc = env.view.meta.settings.feetPerCell;
  const copy = () => {
    select(env.area, null);
    setDraft(env, draftFromTemplate(template, env.actions.newId(), env.view.tokens, fpc));
  };
  const by = caster ? <span style={{ color: theme.color.textMuted }}> · cast by {displayName(caster)}</span> : null;
  return (
    <OptionsStrip
      tool="Area"
      line={inAreaLine({ env, t, moving: st.moving, title: areaTitle(t) + aimSuffix(pitchOf(t)), extra: by })}
      slots={[
        editable && { id: "size", priority: 3, control: <Stepper label="Size" unit="ft" value={t.size} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(size) => update({ size })} /> },
        editable &&
          env.role === "dm" && {
            id: "hidden",
            priority: 4,
            control: (
              // A fixed name that says what pressed means (docs/design-v1-visual.md 3.7).
              <OptButton pressed={t.visibility === "dm"} label="Hide it from players" onClick={() => update({ visibility: t.visibility === "dm" ? "all" : "dm" })}>
                Hidden
              </OptButton>
            ),
          },
        env.role === "dm" && {
          id: "damage",
          priority: 3,
          control: (
            <OptButton ends onClick={() => openDamage(env.area, ui, template.id)}>
              Damage
            </OptButton>
          ),
        },
        {
          id: "copy",
          priority: 2,
          control: (
            <OptButton ends onClick={copy}>
              Copy
            </OptButton>
          ),
        },
        editable && {
          id: "delete",
          priority: 3,
          control: (
            <OptButton tone="danger" ends onClick={() => deleteTemplate(env, template.id)}>
              Delete
            </OptButton>
          ),
        },
        {
          id: "done",
          priority: 1,
          control: (
            <OptButton ends onClick={() => select(env.area, null)}>
              Done
            </OptButton>
          ),
        },
        editable && more("snap", <OptSegmented label="Rotation snap" value={st.snap} options={SNAPS} onChange={(snap) => env.area.store.setState({ snap })} />),
        editable && canPitch(t.shape) && more("aim", <AimControl pitch={pitchOf(t)} onChange={(pitch) => update({ pitch: pitch === 0 ? null : pitch })} />),
        editable && t.shape === "line" && more("width", <Stepper label="Width" unit="ft" value={t.width ?? 5} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(width) => update({ width })} />),
        editable && t.shape === "cylinder" && more("height", <Stepper label="Height" unit="ft" value={t.height ?? 40} step={5} min={AREA_MIN_FT} max={AREA_MAX_FT} onChange={(height) => update({ height })} />),
        editable &&
          t.shape !== "sphere" &&
          t.shape !== "cylinder" &&
          more(
            "includes",
            <OptButton pressed={t.includeOrigin} onClick={() => update({ includeOrigin: !t.includeOrigin })}>
              Includes caster
            </OptButton>,
          ),
        editable &&
          t.shape === "emanation" &&
          (t.attachedTo || caster) &&
          more(
            "attached",
            <OptButton
              pressed={!!t.attachedTo}
              onClick={() => {
                if (t.attachedTo) {
                  // Let go where it stands now, so it does not jump back to
                  // where it was first cast, and keep the token's footprint there.
                  const o = liveOrigin(t, liveContext(env.view, env.scene, false));
                  const token = env.view.tokens[t.attachedTo];
                  update({ attachedTo: null, origin: { x: o.x, y: o.y, z: Math.round(o.z) }, ...(token ? { footprint: emanationFootprint(token, fpc) } : {}) });
                } else if (caster) {
                  update({ attachedTo: caster.id });
                }
              }}
            >
              Moves with token
            </OptButton>,
          ),
        ...(editable
          ? triggerSlots({
              value: t.triggers,
              once: t.oncePerTurn === true,
              onChange: (triggers) => update({ triggers: triggers.length > 0 ? triggers : null }),
              onOnce: (once) => update({ oncePerTurn: once ? true : null }),
            })
          : []),
        editable && more("color", <OptSwatches label="Color" value={t.color} options={MEMBER_COLORS} onChange={(color) => update({ color })} />),
      ]}
    />
  );
}
