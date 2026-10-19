import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ABILITY_KEYS, CR_VALUES, type Actor, type Character, type CompanionBlock, type CustomMonster, type MonsterSize, type StatBlock, type StatBlockEntry } from "#shared/model.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { companionBlockInputSchema, MAX_LEGENDARY_USES, MAX_NAME, monsterInputSchema, type ClientOp } from "#shared/protocol.ts";
import { tokenUses } from "#shared/srd/monsters.ts";
import { ABILITY_ABBR } from "#shared/rules/skills.ts";
import {
  abilityMod,
  hpAverage,
  legendaryUses,
  proficiencyBonus,
  SECTIONS,
  signed,
  SIZE_WORDS,
  SPEED_WORDS,
  speedsOf,
  statBlockMarkdown,
  type SectionKey,
} from "#shared/statBlock.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog, DiscardQuestion } from "../../components/Dialog.tsx";
import { Input, Select, TextArea } from "../../components/Field.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, Section } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import type { OpAnswer, OpRefusal, UnknownCause } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { ownsCharacter } from "../tokens/access.ts";
import { answerSave, markSent, openSave, planSave, saveGone, saveHeld, settleSave, type BlockLive, type BlockSave, type SaveResult } from "./blockSave.ts";
import { blockLines, isDirty, issueText, lateBlockSaveText, monsterPatch, tidy, withCr, withImage, withScore } from "./draft.ts";
import { MonsterImageField } from "./MonsterImage.tsx";
import { parseStatBlockText } from "./parse.ts";

/**
 * The custom monster editor (features section 15): every line of a 2024
 * stat block, for a monster the DM enters from a book the group owns. A
 * pasted stat block fills every field at once, for the DM to check and fix.
 *
 * The whole block is one draft in this dialog and one op on Save, so an
 * edit is one undo step and one change for any other DM's device. A new
 * monster is a `monster.create`. An edit sends only the lines it changed,
 * diffed against the block as the editor opened it, so a line someone
 * else changed meanwhile is kept unless this draft changed it too.
 *
 * With `block` it edits a character's stat block for its companions
 * (docs/design-v1-companion-stat-blocks.md 6.2) for the DM or the
 * character's players, and its Save waits for the server's answer, so a
 * refusal (a cap, the saves budget, a full room) shows here with the draft
 * intact. A block or character that leaves this device's view meanwhile
 * keeps the draft for copying and can no longer be saved.
 */

const SIZE_OPTIONS = (Object.keys(SIZE_WORDS) as MonsterSize[]).map((value) => ({ value, label: SIZE_WORDS[value] }));

const ADD_LABELS: Record<SectionKey, string> = {
  traits: "Add a trait",
  actions: "Add an action",
  bonusActions: "Add a Bonus Action",
  reactions: "Add a Reaction",
  legendaryActions: "Add a Legendary Action",
};

export function MonsterEditor(props: {
  /** The monster being edited, or null for a new one. */
  monster: CustomMonster | null;
  initial: StatBlock;
  /** A character's companion stat block instead of a room monster: the one being edited, or null for a new one, and the SRD monster a copy came from. */
  block?: { character: Pick<Character, "id" | "name">; existing: CompanionBlock | null; fromSrd?: string };
  /** Opens with the paste box ready, for "Paste a stat block". */
  paste?: boolean;
  onClose(): void;
  /** The draft is saved. A character's block comes with the block as the view holds it then. */
  onSaved(id: string, block?: CompanionBlock): void;
}) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  /*
   * What the editor opened with, kept whatever the props say later: the
   * block or monster it saves, and the lines its draft started from. A
   * caller passing the live block, or a link that moves to another block
   * meanwhile, never retargets the save or moves the baseline.
   */
  const [opened] = useState(() => ({ monster: props.monster, block: props.block, initial: props.initial }));
  const target = opened.block;
  const [draft, setDraft] = useState<StatBlock>(opened.initial);
  const [pasteOpen, setPasteOpen] = useState(props.paste ?? false);
  const [pasted, setPasted] = useState("");
  const [readBack, setReadBack] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  // The server's refusal of a block's save, which the problem list heads as not saved rather than as fields to fix.
  const [refused, setRefused] = useState(false);
  const [preview, setPreview] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // While the image picker or crop dialog is open over this one, Escape is theirs to close.
  const [imageOpen, setImageOpen] = useState(false);
  const problems = useRef<HTMLDivElement>(null);
  // Past the saves budget, Save stays off until this moment (docs/design-v1-companion-stat-blocks.md 3.5).
  const [retryAt, setRetryAt] = useState<number | null>(null);
  // A new block's id, chosen once, so a save sent again after a lost answer finds the first one rather than making two.
  const [newBlockId] = useState(() => actions.newId());
  const blockId = target?.existing?.id ?? newBlockId;
  // A block's save waits for its answer (blockSave.ts). The machine's state is read by answers that arrive between renders, so it lives in a ref.
  const machine = useRef<BlockSave>(openSave(target?.existing ? blockLines(target.existing) : null));
  const [held, setHeld] = useState(false);
  const [checking, setChecking] = useState(false);
  const stored = useRoomView((s) => (target ? s.view?.companionBlocks?.[blockId] : undefined));
  const keeper = useRoomView((s) => (target ? s.view?.characters?.[target.character.id] : undefined));
  const monsterHeld = useRoomView((s) => (opened.monster ? s.view?.monsters?.[opened.monster.id] !== undefined : true));
  const snapshots = useRoomView((s) => s.snapshots ?? 0);
  const you = useRoomView((s) => s.you);
  const characterYours = keeper !== undefined && (you?.role === "dm" || ownsCharacter(you?.memberId, keeper));
  const gone = target ? saveGone(machine.current, { stored: stored ? blockLines(stored) : undefined, snapshots }, characterYours) : !monsterHeld;
  /*
   * An answer that comes after Cancel may only say what became of the save:
   * the editor that would have shown it is gone.
   */
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setTimeout(() => setRetryAt(null), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt]);

  const tidied = useMemo(() => tidy(draft), [draft]);
  // The draft as answers read it: they arrive between renders.
  const latest = useRef(tidied);
  latest.current = tidied;
  const dirty = isDirty(opened.initial, draft, pasted);
  const bytes = serializedBytes(tidied);
  const byteLimit = target ? LIMITS.companionBlockBytes : LIMITS.monsterBytes;
  const set = (patch: Partial<StatBlock>) => setDraft((d) => ({ ...d, ...patch }));

  // After the render that shows them: scrolling first would let the browser keep the fields in place and push the list out of sight.
  useEffect(() => {
    if (errors.length > 0) problems.current?.scrollIntoView({ block: "nearest" });
  }, [errors]);

  /** What the view holds of this block now, read from the store, since answers arrive between renders. */
  const live = (): BlockLive => {
    const s = store.getState();
    const now = s.view?.companionBlocks?.[blockId];
    return { stored: now ? blockLines(now) : undefined, snapshots: s.snapshots ?? 0 };
  };
  const commit = (next: BlockSave) => {
    machine.current = next;
    setHeld(saveHeld(next));
    setChecking(next.unsure !== null);
  };
  const saved = () => props.onSaved(blockId, store.getState().view?.companionBlocks?.[blockId]);
  const show = (result: SaveResult) => {
    if (result.kind === "saved") {
      saved();
      return;
    }
    if (result.kind !== "problem") return;
    setErrors([result.text]);
    setRefused(true);
    if (result.retryInMs !== undefined) setRetryAt(Date.now() + result.retryInMs);
  };

  // A snapshot settles an op whose answer was lost while the view could not yet say what it did.
  useEffect(() => {
    if (!target || machine.current.unsure === null) return;
    const settled = settleSave(machine.current, latest.current, live());
    if (!settled.result) return;
    commit(settled.save);
    show(settled.result);
    // Only a new snapshot can settle it, so the snapshot count alone runs this.
  }, [snapshots]);

  const close = () => {
    if (dirty && !leaving) setLeaving(true);
    else props.onClose();
  };

  const read = () => {
    const parsed = parseStatBlockText(pasted);
    // A stat block's text has no image, so a paste keeps the one already chosen.
    setDraft((d) => withImage(parsed.block, d.defaultImage ?? null));
    setReadBack(parsed.warnings);
    setErrors([]);
  };

  const save = () => {
    if (target) {
      saveBlock(target);
      return;
    }
    if (gone) return;
    const id = opened.monster?.id ?? actions.newId();
    const checked = monsterInputSchema.safeParse({ id, ...tidied });
    if (!checked.success) {
      setErrors(issueText(checked.error.issues));
      setPreview(false);
      return;
    }
    if (opened.monster) {
      const patch = monsterPatch(opened.initial, tidied);
      if (Object.keys(patch).length > 0 && actions.dispatch({ t: "monster.update", monsterId: id, patch }) === null) return;
    } else if (actions.dispatch({ t: "monster.create", monster: checked.data }) === null) return;
    props.onSaved(id);
  };

  /**
   * A companion block's save, which waits for the server: a refusal keeps
   * the draft here, where its player can act on it, and the editor closes
   * only once the draft it holds is stored (blockSave.ts).
   */
  const saveBlock = (block: NonNullable<typeof target>) => {
    if (held || gone || retryAt !== null) return;
    const checked = companionBlockInputSchema.safeParse({ id: blockId, characterId: block.character.id, ...(block.fromSrd ? { fromSrd: block.fromSrd } : {}), ...tidied });
    if (!checked.success) {
      setRefused(false);
      setErrors(issueText(checked.error.issues));
      setPreview(false);
      return;
    }
    const planned = planSave(machine.current, tidied, live());
    const intent = planned.intent;
    if (intent.kind === "busy") return;
    if (intent.kind === "saved") {
      commit(planned.save);
      saved();
      return;
    }
    const op: ClientOp = intent.kind === "create" ? { t: "companionBlock.create", block: checked.data } : { t: "companionBlock.update", blockId, patch: intent.patch };
    const name = tidied.name;
    const onAnswer = (answer: OpAnswer, refusal?: OpRefusal, cause?: UnknownCause) => {
      if (!open.current) {
        const text = lateBlockSaveText(name, block.character.name, answer, refusal);
        if (text) ui.notify(text, "error");
        return;
      }
      const answered = answerSave(machine.current, { answer, ...(refusal ? { refusal } : {}), ...(cause ? { cause } : {}) }, latest.current, live(), block.character.name);
      commit(answered.save);
      show(answered.result);
    };
    setErrors([]);
    setRefused(false);
    // In "view as a player" nothing is sent: the preview says so, and the draft stays.
    if (actions.dispatch(op, { onAnswer, quiet: true }) === null) return;
    commit(markSent(planned.save, intent));
  };

  const title = target ? (target.existing ? `Edit ${target.existing.name}` : `New stat block for ${target.character.name}`) : opened.monster ? `Edit ${opened.monster.name}` : "New monster";
  const footer = leaving ? (
    <>
      <Button onClick={() => setLeaving(false)}>Keep editing</Button>
      <Button variant="danger" armed onClick={props.onClose}>
        Discard
      </Button>
    </>
  ) : (
    <>
      <Button pressed={preview} onClick={() => setPreview((p) => !p)}>
        {preview ? "Edit" : "Preview"}
      </Button>
      <span style={{ flex: 1 }} />
      <Button onClick={close}>Cancel</Button>
      <Button variant="primary" busy={held} disabled={gone || retryAt !== null} onClick={save}>
        {held ? "Saving…" : "Save"}
      </Button>
    </>
  );
  const status = leaving ? <DiscardQuestion /> : checking ? "The connection dropped. Checking whether it was saved…" : retryAt !== null ? "You can save again in a few seconds." : null;

  return (
    <Dialog title={title} onClose={imageOpen ? () => {} : close} footer={footer} status={status} phone="fill" width="lg">
      {/* While a save waits, the draft it sent is the draft: the fields hold still until its answer, so nothing typed meanwhile is lost to a close. */}
      <fieldset disabled={held} style={{ display: "grid", gap: theme.space(4), fontSize: theme.font.body14, border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        {gone ? (
          <Notice tone="warning" role="alert">
            {target ? "This stat block was deleted or is no longer yours, so it cannot be saved." : "This monster was deleted, so it cannot be saved."}
          </Notice>
        ) : null}
        {errors.length > 0 ? (
          <div ref={problems}>
            <Notice tone="danger" role="alert">
              <strong>{refused ? "Not saved:" : "Fix these first:"}</strong>
              {errors.map((e) => (
                <p key={e} style={{ margin: `${theme.space(1)}px 0 0` }}>
                  {e}
                </p>
              ))}
            </Notice>
          </div>
        ) : null}
        {bytes > byteLimit * 0.75 ? (
          <Notice tone={bytes > byteLimit ? "danger" : "warning"}>
            {`This stat block is ${(bytes / 1024).toFixed(1)} KiB of the ${byteLimit / 1024} KiB ${target ? "a stat block" : "a monster"} may hold.`}
          </Notice>
        ) : null}
        {preview ? (
          <Markdown text={statBlockMarkdown(tidied)} />
        ) : (
          <>
            <PasteBox
              open={pasteOpen}
              onToggle={() => setPasteOpen((o) => !o)}
              text={pasted}
              onText={setPasted}
              onRead={read}
              readBack={readBack}
              replacing={(target ? target.existing : opened.monster) !== null}
              focus={props.paste ?? false}
            />
            <Section label={target ? "Picture" : "Token image"} divider={false} style={STACKED}>
              <MonsterImageField value={draft.defaultImage} onChange={(image) => setDraft((d) => withImage(d, image))} name={draft.name} onOpen={setImageOpen} />
              <Help>
                {target
                  ? "Each companion added from this stat block starts with this picture."
                  : "Every token placed from this monster starts with this image. After you save, its page offers to put it on its tokens already on this scene."}
              </Help>
            </Section>
            <Basics draft={draft} set={set} />
            <Abilities draft={draft} setDraft={setDraft} />
            <Details draft={draft} set={set} setDraft={setDraft} />
            {SECTIONS.map(({ key, title: heading }) => (
              <Entries
                key={key}
                section={key}
                title={heading}
                entries={draft[key]}
                onChange={(list) => set({ [key]: list })}
                hint={<SectionHint section={key} draft={tidied} companion={target !== undefined} />}
              />
            ))}
          </>
        )}
      </fieldset>
    </Dialog>
  );
}

function PasteBox(props: {
  open: boolean;
  onToggle(): void;
  text: string;
  onText(text: string): void;
  onRead(): void;
  readBack: string[] | null;
  replacing: boolean;
  /** Opened with "Paste a stat block", so the text goes straight in. */
  focus: boolean;
}) {
  const id = useId();
  return (
    <section
      style={{
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        background: theme.color.surfaceRaised,
        border: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    >
      <Button size="sm" onClick={props.onToggle} pressed={props.open}>
        {props.open ? "Hide the paste box" : "Paste a stat block"}
      </Button>
      {props.open ? (
        <>
          <label htmlFor={id} style={{ color: theme.color.textMuted, lineHeight: theme.leading.body }}>
            Copy a whole stat block from a web page or a PDF of a book the group owns, and paste it here. It is read on this device and fills the fields below.
          </label>
          <TextArea
            id={id}
            value={props.text}
            onChange={(e) => props.onText(e.target.value)}
            rows={8}
            spellCheck={false}
            autoFocus={props.focus}
            placeholder={"Cave Lurker\nLarge Monstrosity, Unaligned\nAC 14  Initiative +2 (12)\nHP 22 (4d10)\n…"}
            style={{ width: "100%", fontFamily: theme.font.mono }}
          />
          <Button variant="primary" size="sm" onClick={props.onRead} disabled={props.text.trim() === ""}>
            {props.replacing ? "Read it and replace every field" : "Read the stat block"}
          </Button>
          {props.readBack ? (
            <div role="status" style={{ display: "grid", gap: theme.space(1) }}>
              <Notice>Read. Check every field below against the book before you save.</Notice>
              {props.readBack.map((w) => (
                <Help key={w}>{w}</Help>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** The editor's parts are sections with no line between, spaced by the form's own gap, so none adds the space a panel's section leaves under it. */
const STACKED: CSSProperties = { paddingBottom: 0 };

/** Fields side by side where they fit, one per row on a narrow phone. */
function Row(props: { children: ReactNode; min?: number }) {
  return <div style={{ display: "grid", gap: theme.space(2), gridTemplateColumns: `repeat(auto-fit, minmax(${props.min ?? 130}px, 1fr))` }}>{props.children}</div>;
}

function Labeled(props: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(1), alignContent: "start", minWidth: 0 }}>
      <label htmlFor={id} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
        {props.label}
      </label>
      {props.children(id)}
      {props.hint ? <div style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>{props.hint}</div> : null}
    </div>
  );
}

function Text(props: { label: string; value: string; onChange(value: string): void; placeholder?: string; hint?: ReactNode; maxLength?: number }) {
  return (
    <Labeled label={props.label} hint={props.hint}>
      {(id) => (
        <Input id={id} type="text" value={props.value} placeholder={props.placeholder} maxLength={props.maxLength} onChange={(e) => props.onChange(e.target.value)} style={{ width: "100%" }} />
      )}
    </Labeled>
  );
}

/**
 * A whole number. The text is the field's own while it has focus, so a
 * half-typed "-" or an empty field never fights the draft, and it settles
 * to the draft's number on blur.
 */
function NumberInput(props: { id?: string; label: string; value: number | undefined; onChange(value: number | undefined): void; min: number; max: number; optional?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (props.value === undefined ? "" : String(props.value));
  return (
    <Input
      id={props.id}
      aria-label={props.id ? undefined : props.label}
      type="text"
      inputMode={props.min < 0 ? "text" : "numeric"}
      enterKeyHint="next"
      value={shown}
      onFocus={() => setText(shown)}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const trimmed = raw.trim().replace(/[−–]/g, "-");
        if (trimmed === "") {
          if (props.optional) props.onChange(undefined);
          return;
        }
        const n = Number(trimmed);
        if (Number.isFinite(n)) props.onChange(Math.min(props.max, Math.max(props.min, Math.round(n))));
      }}
      style={{ width: "100%", textAlign: "center" }}
    />
  );
}

function Num(props: { label: string; value: number | undefined; onChange(value: number | undefined): void; min: number; max: number; optional?: boolean; hint?: ReactNode }) {
  return <Labeled label={props.label} hint={props.hint}>{(id) => <NumberInput id={id} {...props} />}</Labeled>;
}

function Choice<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange(value: T): void }) {
  return (
    <Labeled label={props.label}>
      {(id) => (
        <Select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)} style={{ width: "100%" }}>
          {props.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Labeled>
  );
}

function speedSummary(speeds: Actor["speeds"]): string {
  const parts = [`Walk ${speeds.walk} ft.`];
  for (const kind of ["burrow", "climb", "fly", "swim"] as const) {
    const feet = speeds[kind];
    if (feet !== undefined) parts.push(`${SPEED_WORDS[kind]} ${feet} ft.${kind === "fly" && speeds.hover ? " (hover)" : ""}`);
  }
  return parts.join(", ");
}

function Basics(props: { draft: StatBlock; set(patch: Partial<StatBlock>): void }) {
  const { draft, set } = props;
  const average = hpAverage(draft.hp.formula);
  return (
    <Section label="Basics" divider={false} style={STACKED}>
      <Text label="Name" value={draft.name} onChange={(name) => set({ name })} maxLength={80} />
      <Row>
        <Choice label="Size" value={draft.size} options={SIZE_OPTIONS} onChange={(size) => set({ size })} />
        <Choice<MonsterSize | "">
          label="Or a second size"
          value={draft.sizeAlt ?? ""}
          options={[{ value: "", label: "None" }, ...SIZE_OPTIONS]}
          onChange={(value) => set({ sizeAlt: value === "" ? undefined : value })}
        />
      </Row>
      <Row>
        <Text label="Type" value={draft.type} onChange={(type) => set({ type })} placeholder="Dragon (Chromatic)" hint={cutNote(draft.type)} />
        <Text label="Alignment" value={draft.alignment} onChange={(alignment) => set({ alignment })} placeholder="Chaotic Evil" />
      </Row>
      <Row min={110}>
        <Num label="AC" value={draft.ac} min={0} max={100} onChange={(ac) => set({ ac: ac ?? 0 })} />
        <Num label="Initiative" value={draft.initiative} min={-20} max={40} onChange={(n) => set({ initiative: n ?? 0 })} hint={`Score ${10 + draft.initiative}`} />
      </Row>
      <Row min={110}>
        <Num label="HP" value={draft.hp.average} min={0} max={100_000} onChange={(n) => set({ hp: { ...draft.hp, average: n ?? 0 } })} />
        <Text
          label="Hit Point Dice"
          value={draft.hp.formula}
          placeholder="4d10 + 4"
          onChange={(formula) => set({ hp: { ...draft.hp, formula } })}
          hint={
            average !== null && average !== draft.hp.average ? (
              <Button variant="quiet" size="sm" onClick={() => set({ hp: { ...draft.hp, average } })} style={{ padding: 0 }}>
                Use their average, {average}
              </Button>
            ) : null
          }
        />
      </Row>
      <Text label="Speed" value={draft.speed} onChange={(speed) => set({ speed })} placeholder="30 ft., Fly 60 ft. (hover)" hint={`Tokens get ${speedSummary(speedsOf(draft.speed))}`} />
    </Section>
  );
}

/** Three across, like the 2024 block's two rows of three. A save that was the plain modifier follows its score. */
function Abilities(props: { draft: StatBlock; setDraft(update: (d: StatBlock) => StatBlock): void }) {
  const { draft, setDraft } = props;
  return (
    <Section label="Ability scores" divider={false} style={STACKED}>
      <Help>The save is the modifier unless the monster is proficient. Type the printed save when it differs.</Help>
      <div style={{ display: "grid", gap: theme.space(2), gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {ABILITY_KEYS.map((key) => {
          const row = draft.abilities[key];
          return (
            <div key={key} style={{ display: "grid", gap: theme.space(1), padding: theme.space(2), borderRadius: theme.radius.md, background: theme.color.surfaceRaised }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>{ABILITY_ABBR[key]}</strong>
                <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>mod {signed(abilityMod(row.score))}</span>
              </div>
              <NumberInput label={`${ABILITY_ABBR[key]} score`} value={row.score} min={0} max={99} onChange={(n) => setDraft((d) => withScore(d, key, n ?? 10))} />
              <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>Save</span>
              <NumberInput
                label={`${ABILITY_ABBR[key]} save`}
                value={row.save}
                min={-20}
                max={40}
                onChange={(n) => setDraft((d) => ({ ...d, abilities: { ...d.abilities, [key]: { ...d.abilities[key], save: n ?? abilityMod(d.abilities[key].score) } } }))}
              />
            </div>
          );
        })}
      </div>
    </Section>
  );
}

const CR_OPTIONS = CR_VALUES.map((value) => ({ value, label: value }));

function Details(props: { draft: StatBlock; set(patch: Partial<StatBlock>): void; setDraft(update: (d: StatBlock) => StatBlock): void }) {
  const { draft, set } = props;
  return (
    <Section label="Details" divider={false} style={STACKED}>
      <Text label="Skills" value={draft.skills} onChange={(skills) => set({ skills })} placeholder="Perception +5, Stealth +6" />
      <Row>
        <Text label="Vulnerabilities" value={draft.vulnerabilities} onChange={(vulnerabilities) => set({ vulnerabilities })} />
        <Text label="Resistances" value={draft.resistances} onChange={(resistances) => set({ resistances })} />
      </Row>
      <Text label="Immunities" value={draft.immunities} onChange={(immunities) => set({ immunities })} placeholder="Poison; Charmed, Poisoned" hint="Damage types, then a semicolon, then conditions." />
      <Text label="Gear" value={draft.gear} onChange={(gear) => set({ gear })} />
      <Row>
        <Text
          label="Senses"
          value={draft.senses}
          onChange={(senses) => set({ senses })}
          placeholder="Darkvision 60 ft."
          hint={cutNote(draft.senses) ?? "Without Passive Perception, which has its own field."}
        />
        <Num label="Passive Perception" value={draft.passivePerception} min={0} max={60} onChange={(n) => set({ passivePerception: n ?? 10 })} />
      </Row>
      <Text label="Languages" value={draft.languages} onChange={(languages) => set({ languages })} placeholder="Common, Draconic" />
      <Row min={96}>
        <Choice label="CR" value={draft.cr} options={CR_OPTIONS} onChange={(cr) => props.setDraft((d) => withCr(d, cr))} />
        <Num label="XP" value={draft.xp} min={0} max={1_000_000} onChange={(xp) => set({ xp: xp ?? 0 })} hint={`Proficiency Bonus +${proficiencyBonus(draft.cr)}`} />
        <Num label="XP in lair" value={draft.xpInLair} min={0} max={1_000_000} optional onChange={(xpInLair) => set({ xpInLair })} />
      </Row>
    </Section>
  );
}

/**
 * Said under a line longer than a token's field holds, so the DM knows
 * before placing one that its card shows the line cut short (fitLine).
 */
function cutNote(text: string): string | undefined {
  return text.length > MAX_NAME ? `Tokens show the first ${MAX_NAME} characters. The stat block keeps all of it.` : undefined;
}

/**
 * What tokens take from this section's entries, so the DM sees the names
 * that set them were typed right. A companion's block promises no
 * legendary uses, since attaching never sets them.
 */
function SectionHint(props: { section: SectionKey; draft: StatBlock; companion: boolean }) {
  if (props.companion && (props.section === "traits" || props.section === "legendaryActions")) return null;
  const uses = legendaryUses(props.draft);
  const lair = (u: { uses: number; usesInLair?: number }) =>
    u.usesInLair !== undefined ? `${tokenUses(u.uses)} (${tokenUses(u.usesInLair)} in lair)` : String(tokenUses(u.uses));
  const cap = (u: { uses: number; usesInLair?: number }) => (Math.max(u.uses, u.usesInLair ?? 0) > MAX_LEGENDARY_USES ? ` A token holds at most ${MAX_LEGENDARY_USES}.` : "");
  if (props.section === "traits") {
    return uses.legendaryResistance ? (
      <Notice>
        Tokens get Legendary Resistance {lair(uses.legendaryResistance)} a day.{cap(uses.legendaryResistance)}
      </Notice>
    ) : (
      <Help>A trait named “Legendary Resistance (3/Day)” or “Legendary Resistance (3/Day, or 4/Day in Lair)” gives tokens its uses.</Help>
    );
  }
  if (props.section === "legendaryActions") {
    return uses.legendaryActions ? (
      <Notice>
        Tokens get {lair(uses.legendaryActions)} Legendary Actions a round.{cap(uses.legendaryActions)}
      </Notice>
    ) : (
      <Help>Start with an entry named “Legendary Action Uses: 3”, or “Legendary Action Uses: 3 (4 in Lair)”, so tokens get their uses.</Help>
    );
  }
  if (props.section === "actions") return <Help>Each line of an entry’s text is a paragraph. Lines starting “At Will:” or “1/Day Each:” are a spell list, and lines starting “• ” are bullets.</Help>;
  return null;
}

function Entries(props: { section: SectionKey; title: string; entries: StatBlockEntry[]; onChange(entries: StatBlockEntry[]): void; hint: ReactNode }) {
  const { entries, onChange } = props;
  const update = (i: number, patch: Partial<StatBlockEntry>) => onChange(entries.map((e, k) => (k === i ? { ...e, ...patch } : e)));
  const move = (i: number, by: number) => {
    const next = [...entries];
    const [entry] = next.splice(i, 1);
    if (entry) next.splice(i + by, 0, entry);
    onChange(next);
  };
  return (
    <Section label={props.title} divider={false} style={STACKED}>
      {props.hint}
      {entries.map((entry, i) => (
        <EntryEditor
          key={i}
          entry={entry}
          index={i}
          section={props.title}
          onChange={(patch) => update(i, patch)}
          onUp={i > 0 ? () => move(i, -1) : undefined}
          onDown={i < entries.length - 1 ? () => move(i, 1) : undefined}
          onRemove={() => onChange(entries.filter((_, k) => k !== i))}
        />
      ))}
      <Button size="sm" onClick={() => onChange([...entries, { name: "", text: "" }])}>
        {ADD_LABELS[props.section]}
      </Button>
    </Section>
  );
}

function EntryEditor(props: {
  entry: StatBlockEntry;
  index: number;
  section: string;
  onChange(patch: Partial<StatBlockEntry>): void;
  onUp?: () => void;
  onDown?: () => void;
  onRemove(): void;
}) {
  const textId = useId();
  const where = `${props.section} ${props.index + 1}`;
  return (
    <div style={{ display: "grid", gap: theme.space(2), padding: theme.space(2), borderRadius: theme.radius.md, background: theme.color.surfaceRaised }}>
      <Input
        type="text"
        aria-label={`${where}, name`}
        value={props.entry.name}
        placeholder="Name, such as Bite"
        maxLength={120}
        onChange={(e) => props.onChange({ name: e.target.value })}
        style={{ width: "100%", fontWeight: theme.weight.strong }}
      />
      <TextArea
        id={textId}
        aria-label={`${where}, text`}
        value={props.entry.text}
        rows={Math.min(10, Math.max(3, props.entry.text.split("\n").length + 1))}
        onChange={(e) => props.onChange({ text: e.target.value })}
        style={{ width: "100%" }}
      />
      <div style={{ display: "flex", gap: theme.space(2), justifyContent: "flex-end" }}>
        <Button size="sm" icon="arrowUp" iconOnly="always" aria-label={`Move ${where} up`} onClick={props.onUp} disabled={!props.onUp} />
        <Button size="sm" icon="arrowDown" iconOnly="always" aria-label={`Move ${where} down`} onClick={props.onDown} disabled={!props.onDown} />
        <Button variant="danger" size="sm" icon="delete" iconOnly="always" aria-label={`Remove ${where}`} onClick={props.onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}
