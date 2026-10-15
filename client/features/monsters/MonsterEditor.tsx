import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { ABILITY_KEYS, CR_VALUES, type Actor, type CustomMonster, type MonsterSize, type StatBlock, type StatBlockEntry } from "#shared/model.ts";
import { LIMITS, serializedBytes } from "#shared/limits.ts";
import { stableStringify } from "#shared/project.ts";
import { MAX_LEGENDARY_USES, MAX_NAME, monsterInputSchema } from "#shared/protocol.ts";
import { tokenUses } from "#shared/srd/monsters.ts";
import {
  ABILITY_NAMES,
  abilityMod,
  hpAverage,
  legendaryUses,
  proficiencyBonus,
  SECTIONS,
  signed,
  SIZE_WORDS,
  speedsOf,
  statBlockMarkdown,
  type SectionKey,
} from "#shared/statBlock.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Input, Select, TextArea } from "../../components/Field.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions } from "../../state/view.ts";
import { issueText, monsterPatch, tidy, withCr, withImage, withScore } from "./draft.ts";
import { MonsterImageField } from "./MonsterImage.tsx";
import { parseStatBlockText } from "./parse.ts";

/**
 * The custom monster editor (features section 15): every line of a 2024
 * stat block, for a monster the DM enters from a book the group owns. A
 * pasted stat block fills every field at once, for the DM to check and fix.
 *
 * The whole block is one draft in this dialog and one op on Save, so an
 * edit is one undo step and one change for any other DM's device. A new
 * monster is a `monster.create`. An edit sends only the lines it changed.
 */

const SIZE_OPTIONS = (Object.keys(SIZE_WORDS) as MonsterSize[]).map((value) => ({ value, label: SIZE_WORDS[value] }));

const ADD_LABELS: Record<SectionKey, string> = {
  traits: "Add a trait",
  actions: "Add an action",
  bonusActions: "Add a bonus action",
  reactions: "Add a reaction",
  legendaryActions: "Add a legendary action",
};

export function MonsterEditor(props: {
  /** The monster being edited, or null for a new one. */
  monster: CustomMonster | null;
  initial: StatBlock;
  /** Opens with the paste box ready, for "Paste a stat block". */
  paste?: boolean;
  onClose(): void;
  onSaved(id: string): void;
}) {
  const actions = useRoomActions();
  const [draft, setDraft] = useState<StatBlock>(props.initial);
  const [pasteOpen, setPasteOpen] = useState(props.paste ?? false);
  const [pasted, setPasted] = useState("");
  const [readBack, setReadBack] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState(false);
  const [leaving, setLeaving] = useState(false);
  // While the image picker or crop dialog is open over this one, Escape is theirs to close.
  const [imageOpen, setImageOpen] = useState(false);
  const problems = useRef<HTMLDivElement>(null);

  const tidied = useMemo(() => tidy(draft), [draft]);
  const dirty = pasted.trim() !== "" || stableStringify(tidied) !== stableStringify(tidy(props.initial));
  const bytes = serializedBytes(tidied);
  const set = (patch: Partial<StatBlock>) => setDraft((d) => ({ ...d, ...patch }));

  // After the render that shows them: scrolling first would let the browser keep the fields in place and push the list out of sight.
  useEffect(() => {
    if (errors.length > 0) problems.current?.scrollIntoView({ block: "nearest" });
  }, [errors]);

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
    const id = props.monster?.id ?? actions.newId();
    const checked = monsterInputSchema.safeParse({ id, ...tidied });
    if (!checked.success) {
      setErrors(issueText(checked.error.issues));
      setPreview(false);
      return;
    }
    if (props.monster) {
      const patch = monsterPatch(props.monster, tidied);
      if (Object.keys(patch).length > 0 && actions.dispatch({ t: "monster.update", monsterId: id, patch }) === null) return;
    } else if (actions.dispatch({ t: "monster.create", monster: checked.data }) === null) return;
    props.onSaved(id);
  };

  const title = props.monster ? `Edit ${props.monster.name}` : "New monster";
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
      <Button variant="primary" onClick={save}>
        Save
      </Button>
    </>
  );

  return (
    <Dialog
      title={title}
      onClose={imageOpen ? () => {} : close}
      footer={footer}
      status={leaving ? <span style={{ color: theme.color.text, fontSize: theme.font.body14 }}>Throw away your changes?</span> : null}
      phone="fill"
      width="lg"
    >
      <div style={{ display: "grid", gap: theme.space(4), fontSize: theme.font.body14 }}>
        {errors.length > 0 ? (
          <div ref={problems}>
            <Notice tone="danger" role="alert">
              <strong>Fix these first:</strong>
              {errors.map((e) => (
                <p key={e} style={{ margin: `${theme.space(1)}px 0 0` }}>
                  {e}
                </p>
              ))}
            </Notice>
          </div>
        ) : null}
        {bytes > LIMITS.monsterBytes * 0.75 ? (
          <Notice tone={bytes > LIMITS.monsterBytes ? "danger" : "warning"}>
            {`This stat block is ${(bytes / 1024).toFixed(1)} KiB of the ${LIMITS.monsterBytes / 1024} KiB a monster may hold.`}
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
              replacing={props.monster !== null}
              focus={props.paste ?? false}
            />
            <Group title="Token image">
              <MonsterImageField value={draft.defaultImage} onChange={(image) => setDraft((d) => withImage(d, image))} name={draft.name} onOpen={setImageOpen} />
              <Help>Every token placed from this monster starts with this image. After you save, its page offers to put it on its tokens already on this scene.</Help>
            </Group>
            <Basics draft={draft} set={set} />
            <Abilities draft={draft} setDraft={setDraft} />
            <Details draft={draft} set={set} setDraft={setDraft} />
            {SECTIONS.map(({ key, title: heading }) => (
              <Entries key={key} section={key} title={heading} entries={draft[key]} onChange={(list) => set({ [key]: list })} hint={<SectionHint section={key} draft={tidied} />} />
            ))}
          </>
        )}
      </div>
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

/** A group of the stat block's fields under a section label, in muted capitals rather than the accent, which means "act here". */
function Group(props: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: theme.space(2) }}>
      <SectionLabel>{props.title}</SectionLabel>
      {props.hint}
      {props.children}
    </section>
  );
}

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
  const parts = [`walk ${speeds.walk} ft.`];
  for (const kind of ["burrow", "climb", "fly", "swim"] as const) {
    const feet = speeds[kind];
    if (feet !== undefined) parts.push(`${kind} ${feet} ft.${kind === "fly" && speeds.hover ? " (hover)" : ""}`);
  }
  return parts.join(", ");
}

function Basics(props: { draft: StatBlock; set(patch: Partial<StatBlock>): void }) {
  const { draft, set } = props;
  const average = hpAverage(draft.hp.formula);
  return (
    <Group title="Basics">
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
          label="Hit dice"
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
    </Group>
  );
}

/** Three across, like the 2024 block's two rows of three. A save that was the plain modifier follows its score. */
function Abilities(props: { draft: StatBlock; setDraft(update: (d: StatBlock) => StatBlock): void }) {
  const { draft, setDraft } = props;
  return (
    <Group title="Ability scores" hint={<Help>The save is the modifier unless the monster is proficient. Type the printed save when it differs.</Help>}>
      <div style={{ display: "grid", gap: theme.space(2), gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        {ABILITY_KEYS.map((key) => {
          const row = draft.abilities[key];
          return (
            <div key={key} style={{ display: "grid", gap: theme.space(1), padding: theme.space(2), borderRadius: theme.radius.md, background: theme.color.surfaceRaised }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>{ABILITY_NAMES[key]}</strong>
                <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>mod {signed(abilityMod(row.score))}</span>
              </div>
              <NumberInput label={`${ABILITY_NAMES[key]} score`} value={row.score} min={0} max={99} onChange={(n) => setDraft((d) => withScore(d, key, n ?? 10))} />
              <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>Save</span>
              <NumberInput
                label={`${ABILITY_NAMES[key]} save`}
                value={row.save}
                min={-20}
                max={40}
                onChange={(n) => setDraft((d) => ({ ...d, abilities: { ...d.abilities, [key]: { ...d.abilities[key], save: n ?? abilityMod(d.abilities[key].score) } } }))}
              />
            </div>
          );
        })}
      </div>
    </Group>
  );
}

const CR_OPTIONS = CR_VALUES.map((value) => ({ value, label: value }));

function Details(props: { draft: StatBlock; set(patch: Partial<StatBlock>): void; setDraft(update: (d: StatBlock) => StatBlock): void }) {
  const { draft, set } = props;
  return (
    <Group title="Details">
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
        <Num label="XP" value={draft.xp} min={0} max={1_000_000} onChange={(xp) => set({ xp: xp ?? 0 })} hint={`Proficiency bonus +${proficiencyBonus(draft.cr)}`} />
        <Num label="XP in lair" value={draft.xpInLair} min={0} max={1_000_000} optional onChange={(xpInLair) => set({ xpInLair })} />
      </Row>
    </Group>
  );
}

/**
 * Said under a line longer than a token's field holds, so the DM knows
 * before placing one that its card shows the line cut short (fitLine).
 */
function cutNote(text: string): string | undefined {
  return text.length > MAX_NAME ? `Tokens show the first ${MAX_NAME} characters. The stat block keeps all of it.` : undefined;
}

/** What tokens take from this section's entries, so the DM sees the names that set them were typed right. */
function SectionHint(props: { section: SectionKey; draft: StatBlock }) {
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
        Tokens get {lair(uses.legendaryActions)} legendary actions a round.{cap(uses.legendaryActions)}
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
    <Group title={props.title} hint={props.hint}>
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
    </Group>
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
        <Button size="sm" aria-label={`Move ${where} up`} title={`Move ${where} up`} onClick={props.onUp} disabled={!props.onUp}>
          ↑
        </Button>
        <Button size="sm" aria-label={`Move ${where} down`} title={`Move ${where} down`} onClick={props.onDown} disabled={!props.onDown}>
          ↓
        </Button>
        <Button variant="danger" size="sm" aria-label={`Remove ${where}`} title={`Remove ${where}`} onClick={props.onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}
