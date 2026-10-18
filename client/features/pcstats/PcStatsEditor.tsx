import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useStore } from "zustand";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type PcDice, type PcRoll, type PcStats, type SkillKey } from "#shared/model.ts";
import { MAX_PC_DICE_PARTS, MAX_PC_ROLLS, type CharacterPatch } from "#shared/protocol.ts";
import { fillSummary } from "#shared/rules/pcFill.ts";
import { DAMAGE_TYPES, type DamageType } from "#shared/rules/damage.ts";
import { pcActorNumbers, pcDerived, pcProficiency, srdOnPass, unknownOnPass, type PcNumber } from "#shared/rules/pcStats.ts";
import { ABILITY_ABBR, ABILITY_NAMES, SKILLS } from "#shared/rules/skills.ts";
import { signed } from "#shared/statBlock.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Dialog, DiscardQuestion } from "../../components/Dialog.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Input, Select, TextArea } from "../../components/Field.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { editsPcStats } from "../tokens/access.ts";
import { whose } from "../tokens/companionBlocks.ts";
import {
  draftDirty,
  draftProblems,
  editedRoll,
  lateSaveText,
  newRoll,
  openDraft,
  saveOutcome,
  savePatch,
  sizeOf,
  sizeText,
  tidyPart,
  withAllBonus,
  withTotal,
  type PcDraft,
  type TotalKey,
} from "./draft.ts";
import { alsoAny, alsoLines, alsoPatch, readLine, type AlsoKey, type AlsoSet } from "./fill.ts";
import { openFlow, stepFlow, type FlowEvent, type FlowState, type Review } from "./flow.ts";
import { DDB_LINK_ERROR, ddbCharacterId, ddbCharacterUrl } from "#shared/ddb/link.ts";
import { getDdbFill, importErrorText, readPastedJson } from "./ddb.ts";
import { pcPasteWarnings, statsFromBlock } from "./fromBlock.ts";
import { parseStatBlockText } from "../monsters/parse.ts";
import { closePcStats, openPcStatsSlot } from "./open.ts";
import { partsText, rollReading } from "./reading.ts";

/** Draws the player character stat block editors open on this page (open.ts), beside the page, as EditorHost does the monsters'. */
export function PcStatsHost() {
  const store = useScoped(openPcStatsSlot);
  const list = useStore(store, (s) => s.list);
  return (
    <>
      {list.map((e) => (
        <PcStatsEditor key={e.key} characterId={e.characterId} onClose={() => closePcStats(store, e.key)} />
      ))}
    </>
  );
}

/**
 * A player character's stat block editor (docs/design-v1-pc-stats.md 7.2),
 * for the DM and the character's players. The whole block and the level are
 * one draft and one `character.update` on Save, which waits for the
 * server's answer, so a refusal shows here with the draft kept. Each number
 * is one field holding its total, with the parts it comes from under it.
 * A character that leaves the viewer's view meanwhile keeps the draft and
 * can no longer be saved.
 *
 * "Fill from" reads a block in (section 6): its steps show what was read
 * and what it would change, and "Use it" only fills the draft, so a fill
 * is looked over, changed or dropped before Save sends anything. The steps
 * and the Save are one state machine (flow.ts).
 */
export function PcStatsEditor(props: { characterId: string; onClose(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  const character = useRoomView((s) => s.view?.characters[props.characterId]);
  const you = useRoomView((s) => s.you);
  // What the editor opened with, kept whatever the view says later: Save sends only what this draft changed from it.
  const [opened] = useState(() => openDraft(character ?? {}));
  // The editor's steps and its Save (flow.ts). Answers arrive between renders, so the machine's state lives in a ref too.
  const [flow, setFlow] = useState<FlowState>(() => openFlow(opened.draft));
  const flowRef = useRef(flow);
  const draft = flow.draft;
  const name = useRef(character?.name ?? "This character");
  if (character) name.current = character.name;
  const yours = character !== undefined && editsPcStats(you, character);
  const gone = !yours;
  const [refusal, setRefusal] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [pasted, setPasted] = useState("");
  // The D&D Beyond step's field starts with the sheet link when that is a D&D Beyond one.
  const [ddbLink, setDdbLink] = useState(() => (character?.actor.sheetUrl && ddbCharacterId(character.actor.sheetUrl) ? character.actor.sheetUrl : ""));
  const [ddbJson, setDdbJson] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [readingJson, setReadingJson] = useState(false);
  const problems = useMemo(() => draftProblems(draft), [draft]);
  const size = useMemo(() => sizeOf(draft.stats), [draft.stats]);
  const dirty = draftDirty(opened.draft, draft) || alsoAny(flow.also) || pasted.trim() !== "" || ddbJson.trim() !== "";
  const held = flow.saving;
  // An answer that comes after the editor closed may only say what became of the save.
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

  const send = (event: FlowEvent) => {
    const { state, effects } = stepFlow(flowRef.current, event);
    flowRef.current = state;
    setFlow(state);
    for (const effect of effects) {
      if (effect.kind === "close") props.onClose();
      else if (effect.kind === "send") sendSave(state);
      else if (effect.kind === "fetch") startGet(effect.id);
      else {
        gets.current.get(effect.id)?.abort();
        gets.current.delete(effect.id);
      }
    }
  };

  // D&D Beyond requests in flight, by the flow's number, so a newer Get it, Back or closing aborts the one it names.
  const gets = useRef(new Map<number, AbortController>());
  useEffect(() => {
    const live = gets.current;
    return () => {
      for (const controller of live.values()) controller.abort();
    };
  }, []);
  const roomId = useRoomView((s) => s.roomId);
  const startGet = (id: number) => {
    const controller = new AbortController();
    gets.current.set(id, controller);
    getDdbFill(roomId, ddbLink, controller.signal).then(
      (fill) => {
        gets.current.delete(id);
        // A character gone from the view meanwhile still gets its review, with nothing beside the block to set.
        const live = store.getState().view?.characters[props.characterId];
        if (open.current) send({ t: "got", id, result: { fill, lines: live ? alsoLines(fill, live) : [] } });
      },
      (err: unknown) => {
        gets.current.delete(id);
        if (!controller.signal.aborted && open.current) send({ t: "got", id, result: { error: importErrorText(err) } });
      },
    );
  };

  /** The Save's one op: the parts that differ from the block as it opened, and what a fill set beside it, against the character as it is now. */
  const sendSave = (state: FlowState) => {
    const live = store.getState().view?.characters[props.characterId];
    const patch: CharacterPatch = { ...(savePatch(opened.draft, opened.had, state.draft) ?? {}), ...(live ? alsoPatch(state.also, live) : {}) };
    if (Object.keys(patch).length === 0) {
      send({ t: "saved", answer: "taken" });
      return;
    }
    const who = name.current;
    const onAnswer = (answer: OpAnswer, refused?: OpRefusal) => {
      if (!open.current) {
        const text = lateSaveText(who, answer, refused);
        if (text) ui.notify(text, "error");
        return;
      }
      const outcome = saveOutcome(answer, refused, who);
      if (outcome.kind === "problem") {
        setRefusal(outcome.text);
        if (outcome.retryInMs !== undefined) setRetryAt(Date.now() + outcome.retryInMs);
      }
      send({ t: "saved", answer });
    };
    setRefusal(null);
    // In "view as a player" nothing is sent: the preview says so, and the draft stays.
    if (actions.dispatch({ t: "character.update", characterId: props.characterId, patch }, { onAnswer, quiet: true }) === null) send({ t: "saved", answer: "refused" });
  };

  const setDraft = (update: (d: PcDraft) => PcDraft) => send({ t: "edit", update });
  const setStats = (update: (stats: PcStats) => PcStats) => setDraft((d) => ({ ...d, stats: update(d.stats) }));

  const close = () => {
    // A save in flight lands whatever the editor does, and a late refusal is a toast, so closing never waits on it.
    if (dirty && !leaving && !held) setLeaving(true);
    else send({ t: "close" });
  };

  const save = () => {
    if (held || gone || retryAt !== null || problems.length > 0) return;
    send({ t: "save" });
  };

  const readPaste = () => {
    if (!character) return;
    const parsed = parseStatBlockText(pasted);
    const fill = statsFromBlock(parsed.block, draft.level, actions.newId);
    fill.warnings.unshift(...pcPasteWarnings(parsed.warnings));
    send({ t: "read", fill, lines: alsoLines(fill, character) });
  };

  const getIt = () => {
    if (flow.get !== null) return;
    if (!ddbCharacterId(ddbLink)) {
      setLinkError(DDB_LINK_ERROR);
      return;
    }
    setLinkError(null);
    send({ t: "get" });
  };

  const readJson = () => {
    if (readingJson || !character) return;
    setReadingJson(true);
    setLinkError(null);
    readPastedJson(ddbJson).then(
      (result) => {
        setReadingJson(false);
        const live = store.getState().view?.characters[props.characterId];
        if (!open.current) return;
        if ("error" in result) setLinkError(result.error);
        else send({ t: "read", fill: result.fill, lines: live ? alsoLines(result.fill, live) : [] });
      },
      () => {
        setReadingJson(false);
        // The reader's chunk did not load: the shared notice offers a reload.
        if (open.current) setLinkError("The reader did not load. Check the connection, then try again.");
      },
    );
  };

  const discard = leaving ? (
    <>
      <Button onClick={() => setLeaving(false)}>Keep editing</Button>
      <Button variant="danger" armed onClick={() => send({ t: "close" })}>
        Discard
      </Button>
    </>
  ) : null;
  const status = leaving ? <DiscardQuestion /> : retryAt !== null ? "You can save again in a few seconds." : null;
  const back = { label: "Back to the stat block", onBack: () => send({ t: "back" }) };

  if (flow.step === "paste") {
    return (
      <Dialog
        title="Paste text"
        onClose={close}
        back={back}
        status={status}
        phone="fill"
        width="lg"
        footer={
          discard ?? (
            <>
              <Button onClick={() => send({ t: "back" })}>Back</Button>
              <Button variant="primary" disabled={pasted.trim() === ""} onClick={readPaste}>
                Read it
              </Button>
            </>
          )
        }
      >
        <PasteStep text={pasted} onText={setPasted} level={draft.level} name={name.current} />
      </Dialog>
    );
  }

  if (flow.step === "ddb") {
    return (
      <Dialog
        title="D&D Beyond"
        onClose={close}
        back={back}
        status={status}
        phone="fill"
        width="lg"
        footer={
          discard ?? (
            <>
              <Button onClick={() => send({ t: "back" })}>Back</Button>
              <Button variant="primary" busy={flow.get !== null} onClick={getIt}>
                {flow.get !== null ? "Getting it…" : "Get it"}
              </Button>
            </>
          )
        }
      >
        <DdbStep
          link={ddbLink}
          onLink={(v) => {
            setDdbLink(v);
            setLinkError(null);
          }}
          onGet={getIt}
          waiting={flow.get !== null}
          error={linkError ?? flow.error}
          json={ddbJson}
          onJson={setDdbJson}
          onReadJson={readJson}
          readingJson={readingJson}
          name={name.current}
        />
      </Dialog>
    );
  }

  if (flow.step === "review" && flow.review) {
    const review = flow.review;
    return (
      <Dialog
        title="Check what was read"
        onClose={close}
        back={{ label: "Back", onBack: () => send({ t: "back" }) }}
        status={status}
        phone="fill"
        width="lg"
        footer={
          discard ?? (
            <>
              <Button onClick={() => send({ t: "back" })}>Back</Button>
              <Button variant="primary" onClick={() => send({ t: "use" })}>
                Use it
              </Button>
            </>
          )
        }
      >
        <ReviewStep review={review} onToggle={(key) => send({ t: "toggle", key })} />
      </Dialog>
    );
  }

  const footer = discard ?? (
    <>
      <Button onClick={close}>Cancel</Button>
      <Button variant="primary" busy={held} disabled={gone || retryAt !== null || problems.length > 0} onClick={save}>
        {held ? "Saving…" : "Save"}
      </Button>
    </>
  );

  return (
    <Dialog title={`${whose(name.current)} stat block`} onClose={close} footer={footer} status={status} phone="fill" width="lg">
      {/* While a save waits, the draft it sent is the draft: the fields hold still until its answer. */}
      <fieldset disabled={held} style={{ display: "grid", gap: theme.space(4), fontSize: theme.font.body14, border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        {gone ? (
          <Notice tone="warning" role="alert">
            This stat block was deleted or is no longer yours, so it cannot be saved.
          </Notice>
        ) : null}
        <FillFrom onPaste={() => send({ t: "open", step: "paste" })} onDdb={() => send({ t: "open", step: "ddb" })} />
        {alsoAny(flow.also) ? <Help>{`Save also sets ${alsoWords(flow.also)}.`}</Help> : null}
        <LevelRow draft={draft} onLevel={(level) => setDraft((x) => ({ ...x, level }))} />
        <Abilities stats={draft.stats} level={draft.level} setStats={setStats} />
        <Skills stats={draft.stats} level={draft.level} setStats={setStats} />
        <OtherNumbers stats={draft.stats} level={draft.level} setStats={setStats} />
        <Spellcasting stats={draft.stats} level={draft.level} setStats={setStats} />
        <Defenses stats={draft.stats} setStats={setStats} />
        <Rolls stats={draft.stats} level={draft.level} setStats={setStats} newId={actions.newId} />
        {size.near && !size.over ? <Notice tone="warning">{sizeText(size.bytes)}</Notice> : null}
        {refusal ? (
          <Notice tone="danger" role="alert">
            <strong>Not saved:</strong> {refusal}
          </Notice>
        ) : null}
        {problems.length > 0 ? (
          <div role="status">
            <Notice tone="danger">
              <strong>Fix these first:</strong>
              {problems.map((p) => (
                <p key={p} style={{ margin: `${theme.space(1)}px 0 0` }}>
                  {p}
                </p>
              ))}
            </Notice>
          </div>
        ) : null}
      </fieldset>
    </Dialog>
  );
}

/** "Fill from" (7.2): the steps that read a block in, one row. */
function FillFrom(props: { onPaste(): void; onDdb(): void }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
      <span style={{ fontWeight: theme.weight.strong }}>Fill from</span>
      <Button size="sm" onClick={props.onPaste}>
        Paste text
      </Button>
      <Button size="sm" onClick={props.onDdb}>
        D&amp;D Beyond
      </Button>
    </div>
  );
}

/**
 * "D&D Beyond" (6.3): a public character's share link or number, which the
 * server fetches, or its JSON pasted and read on this device. Get it is
 * busy under the shared delayed indicator and refuses a second tap. Once a
 * number is known, the step links to the data's own page, whose text can be
 * copied whole.
 */
function DdbStep(props: {
  link: string;
  onLink(link: string): void;
  onGet(): void;
  waiting: boolean;
  error: string | null;
  json: string;
  onJson(json: string): void;
  onReadJson(): void;
  readingJson: boolean;
  name: string;
}) {
  const linkId = useId();
  const jsonId = useId();
  const [pasting, setPasting] = useState(false);
  const id = ddbCharacterId(props.link);
  return (
    <div style={{ display: "grid", gap: theme.space(3), fontSize: theme.font.body14 }}>
      <Help>{`The character must be Public in D&D Beyond. The import reads numbers, proficiencies, weapons and spells, never their text, and you check what it read before anything is saved. It is best effort: D&D Beyond can change its format.`}</Help>
      <label htmlFor={linkId} style={{ fontWeight: theme.weight.strong }}>
        Share link or character number
      </label>
      <Input
        id={linkId}
        type="text"
        inputMode="url"
        value={props.link}
        maxLength={300}
        placeholder="dndbeyond.com/characters/12345678"
        spellCheck={false}
        onChange={(e) => props.onLink(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            props.onGet();
          }
        }}
        style={{ width: "100%" }}
      />
      {props.waiting ? <Loading text={`Getting ${props.name} from D&D Beyond…`} /> : null}
      {props.error ? (
        <Notice tone="danger" role="alert">
          {props.error}
        </Notice>
      ) : null}
      {id ? (
        <a href={ddbCharacterUrl(id)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), minHeight: theme.touch, color: theme.color.accent, fontWeight: theme.weight.strong }}>
          Open its data in D&amp;D Beyond
          <Icon name="external" size="sm" />
        </a>
      ) : null}
      <Button size="sm" expanded={pasting} onClick={() => setPasting((p) => !p)} style={{ justifySelf: "start" }}>
        Paste its JSON instead
      </Button>
      {pasting ? (
        <>
          <label htmlFor={jsonId} style={{ color: theme.color.textMuted, lineHeight: theme.leading.body }}>
            Open its data in D&amp;D Beyond, copy the whole page, and paste it here. It is read on this device, up to 5 MiB.
          </label>
          <TextArea id={jsonId} value={props.json} onChange={(e) => props.onJson(e.target.value)} rows={8} spellCheck={false} style={{ width: "100%", fontFamily: theme.font.mono }} />
          <Button size="sm" variant="primary" busy={props.readingJson} disabled={props.json.trim() === ""} onClick={props.onReadJson} style={{ justifySelf: "start" }}>
            {props.readingJson ? "Reading…" : "Read it"}
          </Button>
          {props.readingJson ? <Loading text="Reading the character…" /> : null}
        </>
      ) : null}
    </div>
  );
}

const ALSO_WORDS: Record<keyof AlsoSet, string> = { level: "the level", name: "the name", ac: "AC", hpMax: "max HP", speeds: "the speed", senses: "the senses", sheetUrl: "the sheet link" };

/** "the level, AC and max HP" */
function alsoWords(also: AlsoSet): string {
  const words = (Object.keys(also) as (keyof AlsoSet)[]).map((k) => ALSO_WORDS[k]);
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "Paste text" (6.2): a stat block copied whole, read on this device by the monster editor's reader. */
function PasteStep(props: { text: string; onText(text: string): void; level: number | undefined; name: string }) {
  const id = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
      <label htmlFor={id} style={{ color: theme.color.textMuted, lineHeight: theme.leading.body }}>
        Paste a whole stat block, from its name to its last action. It is read on this device, and you check what it read before anything is saved.
      </label>
      <TextArea
        id={id}
        value={props.text}
        onChange={(e) => props.onText(e.target.value)}
        rows={10}
        spellCheck={false}
        autoFocus
        placeholder={"Bree Tallow\nMedium Humanoid, Neutral Good\nAC 15  Initiative +3 (13)\n…"}
        style={{ width: "100%", fontFamily: theme.font.mono }}
      />
      {props.level === undefined ? <Notice tone="warning">{`Set ${whose(props.name)} level first, so proficiency reads right.`}</Notice> : null}
    </div>
  );
}

/** The review (6.1): what was read, what to check, what it replaces, and the other fields it sets, each ticked or not. */
function ReviewStep(props: { review: Review; onToggle(key: AlsoKey): void }) {
  const { review } = props;
  return (
    <div style={{ display: "grid", gap: theme.space(3), fontSize: theme.font.body14 }}>
      <p style={{ margin: 0 }}>{readLine(review.fill)}</p>
      {review.fill.warnings.length > 0 ? (
        <section style={{ display: "grid", gap: theme.space(1) }}>
          <SectionLabel>Check these</SectionLabel>
          {review.fill.warnings.map((w, i) => (
            <p key={i} style={{ margin: 0 }}>
              {w}
            </p>
          ))}
        </section>
      ) : null}
      <p style={{ margin: 0 }}>{fillSummary(review.fill, review.merge)}</p>
      {review.lines.length > 0 ? (
        <section style={{ display: "grid", gap: theme.space(1) }}>
          <SectionLabel>Also set</SectionLabel>
          {review.lines.map((line) => (
            <Checkbox key={line.key} label={line.text} checked={line.on} onChange={() => props.onToggle(line.key)} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

const HIDDEN: CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };

type StatsProps = { stats: PcStats; level: number | undefined; setStats(update: (stats: PcStats) => PcStats): void };

/** A group of fields under a section label. */
function Group(props: { title: string; hint?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: theme.space(2), minWidth: 0 }}>
      <SectionLabel action={props.action}>{props.title}</SectionLabel>
      {props.hint}
      {props.children}
    </section>
  );
}

/**
 * A whole number. The text is the field's own while it has focus, so a
 * half-typed "-" or an empty field never fights the draft, and it settles
 * to the draft's number on blur. Empty is null where the field allows it.
 */
function IntInput(props: {
  id?: string;
  label?: string;
  value: number | undefined;
  onChange(value: number | null): void;
  min: number;
  max: number;
  nullable?: boolean;
  placeholder?: string;
  width?: number;
  /** A bonus, shown with its sign while the field is not being edited: "+4", "−1". */
  sign?: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (props.value === undefined ? "" : props.sign ? signed(props.value) : String(props.value));
  return (
    <Input
      id={props.id}
      aria-label={props.id ? undefined : props.label}
      type="text"
      inputMode={props.min < 0 ? "text" : "numeric"}
      enterKeyHint="next"
      value={shown}
      placeholder={props.placeholder}
      onFocus={() => setText(shown)}
      onBlur={() => setText(null)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const trimmed = raw.trim().replace(/[−–]/g, "-").replace(/^\+/, "");
        if (trimmed === "") {
          if (props.nullable) props.onChange(null);
          return;
        }
        const n = Number(trimmed);
        if (Number.isFinite(n)) props.onChange(Math.min(props.max, Math.max(props.min, Math.round(n))));
      }}
      style={{ width: props.width ?? 72, textAlign: "center" }}
    />
  );
}

/** A number's field holding its total (section 3.3): typing keeps the difference from the rules, and clearing sets it to 0. */
function TotalInput(props: { label: string; number: PcNumber; onTotal(total: number | null): void; score?: boolean }) {
  return <IntInput label={props.label} value={props.number.total} min={-60} max={100} nullable sign={!props.score} onChange={props.onTotal} />;
}

/**
 * One wrapping row (7.2): its name and what it reads first, then its
 * controls as one group that drops under them when the row is too narrow
 * for both, about 290 px, and the parts of its total under it all.
 */
function NumberRow(props: { name: ReactNode; aside?: ReactNode; controls: ReactNode; hint?: string }) {
  return (
    <div style={{ display: "grid", gap: theme.space(1), padding: `${theme.space(1)}px 0`, borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: theme.space(3), rowGap: theme.space(1) }}>
        <span style={{ display: "inline-flex", alignItems: "baseline", gap: theme.space(2), minWidth: 0, flex: "1 1 auto" }}>
          <strong style={{ overflowWrap: "anywhere" }}>{props.name}</strong>
          {props.aside ? <span style={{ color: theme.color.textMuted }}>{props.aside}</span> : null}
        </span>
        <span style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), flex: "0 1 auto" }}>{props.controls}</span>
      </div>
      {props.hint ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{props.hint}</span> : null}
    </div>
  );
}

function LevelRow(props: { draft: PcDraft; onLevel(level: number | undefined): void }) {
  const id = useId();
  const pb = pcProficiency(props.draft.level);
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(3) }}>
        <label htmlFor={id} style={{ fontWeight: theme.weight.strong }}>
          Level
        </label>
        {/* Wide enough for "Not set" whole at 16 px, which a two-digit field cuts to "Not se". */}
        <IntInput id={id} value={props.draft.level} min={1} max={20} nullable placeholder="Not set" width={96} onChange={(n) => props.onLevel(n ?? undefined)} />
        <span style={{ color: theme.color.textMuted }}>Proficiency {signed(pb)}</span>
      </div>
      {props.draft.level === undefined ? <Help>Level not set: proficiency +2.</Help> : null}
    </div>
  );
}

function Abilities(props: StatsProps) {
  const { stats, level, setStats } = props;
  const d = pcDerived(stats, level);
  return (
    <Group title="Abilities" hint={<Help>Each save shows its total. Type a different total to keep a bonus the rules do not know, such as a Cloak of Protection’s.</Help>}>
      {ABILITY_KEYS.map((a) => {
        const proficient = stats.saves.includes(a);
        return (
          <NumberRow
            key={a}
            name={ABILITY_NAMES[a]}
            aside={signed(d.mods[a])}
            hint={`Save: ${partsText(d.saves[a])}`}
            controls={
              <>
                <IntInput label={`${ABILITY_NAMES[a]} score`} value={stats.abilities[a]} min={1} max={30} onChange={(n) => setStats((s) => ({ ...s, abilities: { ...s.abilities, [a]: n ?? 10 } }))} width={64} />
                <Checkbox
                  // Six of these sit in a column, so each says which save it is to a screen reader.
                  label={
                    <>
                      Proficient<span style={HIDDEN}>{` in ${ABILITY_NAMES[a]} saves`}</span>
                    </>
                  }
                  checked={proficient}
                  onChange={(on) => setStats((s) => ({ ...s, saves: on ? ABILITY_KEYS.filter((k) => k === a || s.saves.includes(k)) : s.saves.filter((k) => k !== a) }))}
                />
                {/* "Save" and its total wrap as one, so a narrow row never leaves the total alone under its word (LP7-PC-12). */}
                <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2), flex: "none" }}>
                  <span aria-hidden style={{ color: theme.color.textMuted }}>
                    Save
                  </span>
                  <TotalInput label={`${ABILITY_NAMES[a]} save`} number={d.saves[a]} onTotal={(t) => setStats((s) => withTotal(s, level, { kind: "save", ability: a }, t))} />
                </span>
              </>
            }
          />
        );
      })}
    </Group>
  );
}

const SKILL_LEVELS = [
  { value: "none", label: "None" },
  { value: "prof", label: "Proficient" },
  { value: "expert", label: "Expertise" },
] as const;

function Skills(props: StatsProps) {
  const { stats, level, setStats } = props;
  const d = pcDerived(stats, level);
  const setSkill = (skill: SkillKey, value: "none" | "prof" | "expert") =>
    setStats((s) => {
      const skills = { ...s.skills };
      if (value === "none") delete skills[skill];
      else skills[skill] = value;
      return { ...s, skills };
    });
  return (
    <Group title="Skills">
      <Checkbox label="Jack of All Trades" help="Half the proficiency bonus, rounded down, on every skill with neither" checked={stats.jack === true} onChange={(on) => setStats((s) => withFlag(s, "jack", on))} />
      {SKILL_KEYS.map((skill) => (
        <NumberRow
          key={skill}
          name={SKILLS[skill].name}
          aside={ABILITY_ABBR[SKILLS[skill].ability]}
          hint={partsText(d.skills[skill])}
          controls={
            <>
              <Select aria-label={`${SKILLS[skill].name} proficiency`} value={stats.skills[skill] ?? "none"} onChange={(e) => setSkill(skill, e.target.value as "none" | "prof" | "expert")} style={{ width: 136 }}>
                {SKILL_LEVELS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <TotalInput label={`${SKILLS[skill].name} total`} number={d.skills[skill]} onTotal={(t) => setStats((s) => withTotal(s, level, { kind: "skill", skill }, t))} />
            </>
          }
        />
      ))}
    </Group>
  );
}

function withFlag<K extends "jack" | "alert" | "evasion">(stats: PcStats, key: K, on: boolean): PcStats {
  const next = { ...stats };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

function OtherNumbers(props: StatsProps) {
  const { stats, level, setStats } = props;
  const d = pcDerived(stats, level);
  // The actor holds these two within its bounds, so a total past them says what the token keeps (docs/design-v1-pc-stats.md 10).
  const held = pcActorNumbers(stats, level);
  const total = (key: TotalKey) => (t: number | null) => setStats((s) => withTotal(s, level, key, t));
  return (
    <Group title="Other numbers">
      <NumberRow
        name="Initiative"
        hint={held.initBonus === d.initiative.total ? partsText(d.initiative) : `${partsText(d.initiative)}. The token’s Initiative stops at ${signed(held.initBonus)}.`}
        controls={
          <>
            <Checkbox label="Alert: add proficiency" checked={stats.alert === true} onChange={(on) => setStats((s) => withFlag(s, "alert", on))} />
            <TotalInput label="Initiative" number={d.initiative} onTotal={total({ kind: "init" })} />
          </>
        }
      />
      <NumberRow
        name="Passive Perception"
        hint={held.passivePerception === d.passive.total ? partsText(d.passive) : `${partsText(d.passive)}. The token’s Passive Perception stops at ${held.passivePerception}.`}
        controls={<TotalInput label="Passive Perception" number={d.passive} score onTotal={total({ kind: "passive" })} />}
      />
      <NumberRow
        name="All saves"
        hint="Added to every saving throw, a death save included"
        controls={<IntInput label="All saves" value={d.allSaves} min={-20} max={20} nullable sign onChange={(n) => setStats((s) => withAllBonus(s, "allSaves", n))} />}
      />
      <NumberRow
        name="All checks"
        hint="Added to every ability check, Initiative included"
        controls={<IntInput label="All checks" value={d.allChecks} min={-20} max={20} nullable sign onChange={(n) => setStats((s) => withAllBonus(s, "allChecks", n))} />}
      />
      <NumberRow
        name="Critical Hits on"
        hint="Improved Critical and Superior Critical widen a weapon attack’s range"
        controls={
          <Select
            aria-label="Critical Hits on"
            value={String(stats.critOn ?? 20)}
            onChange={(e) =>
              setStats((s) => {
                const next = { ...s };
                const n = Number(e.target.value);
                if (n === 19 || n === 18) next.critOn = n;
                else delete next.critOn;
                return next;
              })
            }
            style={{ width: 136 }}
          >
            <option value="20">20</option>
            <option value="19">19 and up</option>
            <option value="18">18 and up</option>
          </Select>
        }
      />
    </Group>
  );
}

function Spellcasting(props: StatsProps) {
  const { stats, level, setStats } = props;
  const d = pcDerived(stats, level);
  const id = useId();
  const total = (key: TotalKey) => (t: number | null) => setStats((s) => withTotal(s, level, key, t));
  const usesSpell = stats.rolls.some((r) => r.ability === "spell");
  return (
    <Group title="Spellcasting">
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(3) }}>
        <label htmlFor={id} style={{ fontWeight: theme.weight.strong }}>
          Spellcasting ability
        </label>
        <Select
          id={id}
          value={stats.spellAbility ?? ""}
          onChange={(e) =>
            setStats((s) => {
              const next = { ...s };
              const value = e.target.value as AbilityKey | "";
              if (value === "") delete next.spellAbility;
              else next.spellAbility = value;
              return next;
            })
          }
          style={{ width: 176 }}
        >
          <option value="">None</option>
          {ABILITY_KEYS.map((a) => (
            <option key={a} value={a}>
              {ABILITY_NAMES[a]}
            </option>
          ))}
        </Select>
      </div>
      {d.spell ? (
        <>
          <NumberRow name="Spell save DC" hint={partsText(d.spell.dc)} controls={<TotalInput label="Spell save DC" number={d.spell.dc} score onTotal={total({ kind: "spellDc" })} />} />
          <NumberRow name="Spell attack" hint={partsText(d.spell.attack)} controls={<TotalInput label="Spell attack" number={d.spell.attack} onTotal={total({ kind: "spellAttack" })} />} />
        </>
      ) : usesSpell ? (
        <Notice tone="warning">Choose a spellcasting ability. Rolls that use it add nothing until you do.</Notice>
      ) : null}
    </Group>
  );
}

const DEFENSE_OPTIONS = [
  { value: "", label: "None" },
  { value: "resistant", label: "Resistant" },
  { value: "immune", label: "Immune" },
  { value: "vulnerable", label: "Vulnerable" },
] as const;

function Defenses(props: Pick<StatsProps, "stats" | "setStats">) {
  const { stats, setStats } = props;
  const [open, setOpen] = useState(false);
  const count = Object.keys(stats.defenses).length + (stats.evasion ? 1 : 0);
  return (
    <section style={{ display: "grid", gap: theme.space(2) }}>
      <Button size="sm" expanded={open} onClick={() => setOpen((o) => !o)} style={{ justifyContent: "space-between", width: "100%" }}>
        {count > 0 ? `Defenses (${count})` : "Defenses"}
      </Button>
      {open ? (
        <>
          <Checkbox label="Evasion" help="A Dexterity save for half the damage takes none on a pass and half on a fail" checked={stats.evasion === true} onChange={(on) => setStats((s) => withFlag(s, "evasion", on))} />
          {DAMAGE_TYPES.map((type) => (
            <NumberRow
              key={type}
              name={capital(type)}
              controls={
                <Select
                  aria-label={`${capital(type)} damage`}
                  value={stats.defenses[type] ?? ""}
                  onChange={(e) =>
                    setStats((s) => {
                      const defenses = { ...s.defenses };
                      const value = e.target.value as "" | "resistant" | "immune" | "vulnerable";
                      if (value === "") delete defenses[type];
                      else defenses[type] = value;
                      return { ...s, defenses };
                    })
                  }
                  style={{ width: 136 }}
                >
                  {DEFENSE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              }
            />
          ))}
        </>
      ) : null}
    </section>
  );
}

function capital(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

const ROLL_GROUPS = [
  { kind: "weapon", title: "Weapons", add: "Add a weapon" },
  { kind: "spell", title: "Spells", add: "Add a spell" },
  { kind: "other", title: "Other rolls", add: "Add a roll" },
] as const;

function Rolls(props: StatsProps & { newId(): string }) {
  const { stats, level, setStats } = props;
  const [openId, setOpenId] = useState<string | null>(null);
  const full = stats.rolls.length >= MAX_PC_ROLLS;
  const replace = (roll: PcRoll, next: PcRoll) => setStats((s) => ({ ...s, rolls: s.rolls.map((r) => (r.id === roll.id ? editedRoll(r, next) : r)) }));
  const remove = (roll: PcRoll) => setStats((s) => ({ ...s, rolls: s.rolls.filter((r) => r.id !== roll.id) }));
  const add = (kind: PcRoll["kind"]) => {
    const roll = newRoll(kind, props.newId());
    setStats((s) => ({ ...s, rolls: [...s.rolls, roll] }));
    setOpenId(roll.id);
  };
  return (
    <>
      {ROLL_GROUPS.map((group) => (
        <Group key={group.kind} title={group.title}>
          {stats.rolls
            .filter((r) => r.kind === group.kind)
            .map((roll) => (
              <RollRow
                key={roll.id}
                roll={roll}
                stats={stats}
                level={level}
                open={openId === roll.id}
                onToggle={() => setOpenId((id) => (id === roll.id ? null : roll.id))}
                onChange={(next) => replace(roll, next)}
                onRemove={() => remove(roll)}
              />
            ))}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(3) }}>
            <Button size="sm" disabled={full} onClick={() => add(group.kind)}>
              {group.add}
            </Button>
            <span style={{ color: theme.color.textMuted, fontSize: theme.font.small }}>{full ? "At most 40 rolls." : `${stats.rolls.length} of ${MAX_PC_ROLLS} rolls`}</span>
          </div>
        </Group>
      ))}
    </>
  );
}

const ROLL_ABILITY_OPTIONS: readonly { value: AbilityKey | "spell" | ""; label: string }[] = [
  { value: "", label: "None" },
  ...ABILITY_KEYS.map((a) => ({ value: a, label: ABILITY_NAMES[a] })),
  { value: "spell", label: "Spellcasting ability" },
];

const KIND_OPTIONS = [
  { value: "weapon", label: "Weapon" },
  { value: "spell", label: "Spell" },
  { value: "other", label: "Other" },
] as const;

const TYPE_OPTIONS: readonly { value: DamageType | "healing" | ""; label: string }[] = [{ value: "", label: "No type" }, ...DAMAGE_TYPES.map((t) => ({ value: t, label: capital(t) })), { value: "healing", label: "Healing" }];

/** A labeled control in a roll's fields, its label above it. */
function Labeled(props: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div style={{ display: "grid", gap: theme.space(1), alignContent: "start", minWidth: 0 }}>
      <label htmlFor={id} style={{ fontWeight: theme.weight.strong }}>
        {props.label}
      </label>
      {props.children(id)}
    </div>
  );
}

function FieldsRow(props: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: theme.space(3) }}>{props.children}</div>;
}

/** One roll: a disclosure with its name and what it reads, opening to its fields. */
function RollRow(props: { roll: PcRoll; stats: PcStats; level: number | undefined; open: boolean; onToggle(): void; onChange(next: PcRoll): void; onRemove(): void }) {
  const { roll, stats, level, onChange } = props;
  const title = roll.name.trim() || (roll.kind === "weapon" ? "New weapon" : roll.kind === "spell" ? "New spell" : "New roll");
  const reading = rollReading(stats, level, roll);
  const set = (patch: Partial<PcRoll>) => onChange({ ...roll, ...patch });
  const without = <K extends keyof PcRoll>(key: K): PcRoll => {
    const next = { ...roll };
    delete next[key];
    return next;
  };
  const spell = roll.kind === "spell";
  const setPart = (i: number, part: PcDice) => onChange({ ...roll, dice: roll.dice.map((p, k) => (k === i ? tidyPart(part) : p)) });
  return (
    <div style={{ display: "grid", gap: theme.space(2), padding: theme.space(2), borderRadius: theme.radius.md, background: theme.color.surfaceRaised, minWidth: 0 }}>
      <Button size="sm" variant="quiet" expanded={props.open} onClick={props.onToggle} style={{ justifyContent: "flex-start", textAlign: "left", width: "100%", whiteSpace: "normal", minWidth: 0 }}>
        <span style={{ display: "grid", minWidth: 0 }}>
          <strong style={{ overflowWrap: "anywhere" }}>
            {title}
            {roll.ddb ? <span style={{ fontWeight: theme.weight.regular, color: theme.color.textMuted }}> (from D&D Beyond)</span> : null}
          </strong>
          {reading ? <span style={{ color: theme.color.textMuted, fontWeight: theme.weight.regular, overflowWrap: "anywhere" }}>{reading}</span> : null}
        </span>
      </Button>
      {props.open ? (
        <div style={{ display: "grid", gap: theme.space(3), minWidth: 0 }}>
          <Labeled label="Name">
            {(id) => <Input id={id} type="text" value={roll.name} maxLength={60} autoFocus={roll.name === ""} onChange={(e) => set({ name: e.target.value })} style={{ width: "100%" }} />}
          </Labeled>
          <FieldsRow>
            <Labeled label="Kind">
              {(id) => (
                <Select
                  id={id}
                  value={roll.kind}
                  onChange={(e) => {
                    const kind = e.target.value as PcRoll["kind"];
                    const next: PcRoll = { ...roll, kind };
                    if (kind !== "spell") delete next.level;
                    else if (next.level === undefined) next.level = 1;
                    onChange(next);
                  }}
                  style={{ width: 136 }}
                >
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Labeled>
            <Labeled label="Ability">
              {(id) => (
                <Select
                  id={id}
                  value={roll.ability ?? ""}
                  onChange={(e) => {
                    const value = e.target.value as AbilityKey | "spell" | "";
                    onChange(value === "" ? without("ability") : { ...roll, ability: value });
                  }}
                  style={{ width: 196 }}
                >
                  {ROLL_ABILITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Labeled>
            {spell ? (
              <Labeled label="Spell level">
                {(id) => (
                  <Select id={id} value={String(roll.level ?? 0)} onChange={(e) => set({ level: Number(e.target.value) })} style={{ width: 120 }}>
                    {Array.from({ length: 10 }, (_, n) => (
                      <option key={n} value={n}>
                        {n === 0 ? "Cantrip" : `Level ${n}`}
                      </option>
                    ))}
                  </Select>
                )}
              </Labeled>
            ) : null}
          </FieldsRow>
          <Checkbox label="Attack roll" checked={roll.attack !== undefined} onChange={(on) => onChange(on ? { ...roll, attack: { prof: true, bonus: 0 } } : without("attack"))} />
          {roll.attack ? (
            <FieldsRow>
              {spell ? null : <Checkbox label="Proficient" checked={roll.attack.prof} onChange={(prof) => set({ attack: { ...roll.attack!, prof } })} />}
              <Labeled label="Other bonus">{(id) => <IntInput id={id} value={roll.attack!.bonus} min={-20} max={20} nullable sign onChange={(n) => set({ attack: { ...roll.attack!, bonus: n ?? 0 } })} />}</Labeled>
            </FieldsRow>
          ) : null}
          <Checkbox label="Save" help="A saving throw it forces" checked={roll.save !== undefined} onChange={(on) => onChange(on ? { ...roll, save: { ability: "dex" } } : without("save"))} />
          {roll.save ? (
            <FieldsRow>
              <Labeled label="Save ability">
                {(id) => (
                  <Select id={id} value={roll.save!.ability} onChange={(e) => set({ save: { ...roll.save!, ability: e.target.value as AbilityKey } })} style={{ width: 160 }}>
                    {ABILITY_KEYS.map((a) => (
                      <option key={a} value={a}>
                        {ABILITY_NAMES[a]}
                      </option>
                    ))}
                  </Select>
                )}
              </Labeled>
              <Labeled label="Fixed DC">
                {(id) => (
                  <IntInput
                    id={id}
                    value={roll.save!.dc}
                    min={1}
                    max={50}
                    nullable
                    placeholder="Worked out"
                    onChange={(dc) => {
                      // A typed DC stands for the whole number, so a worked-out DC's bonus goes with it.
                      const { dc: _dc, bonus, ...rest } = roll.save!;
                      set({ save: dc === null ? { ...rest, ...(bonus !== undefined ? { bonus } : {}) } : { ...rest, dc } });
                    }}
                    width={112}
                  />
                )}
              </Labeled>
              <Labeled label="On a pass">
                {(id) => (
                  <Select
                    id={id}
                    value={roll.save!.onPass ?? ""}
                    onChange={(e) => {
                      const { onPass: _onPass, ...rest } = roll.save!;
                      const value = e.target.value;
                      set({ save: value === "half" || value === "none" ? { ...rest, onPass: value } : rest });
                    }}
                    style={{ width: 120 }}
                  >
                    <option value="">Not set</option>
                    <option value="half">Half</option>
                    <option value="none">None</option>
                  </Select>
                )}
              </Labeled>
            </FieldsRow>
          ) : null}
          {roll.save && roll.save.onPass === undefined ? (
            <Help>{onPassHint(roll)}</Help>
          ) : null}
          {roll.dice.map((part, i) => (
            <PartFields key={i} roll={roll} part={part} index={i} onChange={(next) => setPart(i, next)} onRemove={() => onChange({ ...roll, dice: roll.dice.filter((_, k) => k !== i) })} />
          ))}
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2), justifyContent: "space-between" }}>
            <Button size="sm" disabled={roll.dice.length >= MAX_PC_DICE_PARTS} onClick={() => set({ dice: [...roll.dice, { formula: "" }] })}>
              Add dice
            </Button>
            <Button size="sm" variant="danger" aria-label={`Remove ${title}`} onClick={props.onRemove}>
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** What an unset "On a pass" reads as, and where that comes from (W7B-P-2). */
function onPassHint(roll: PcRoll): string {
  const reads = unknownOnPass(roll) === "half" ? "half the damage" : "no damage";
  if (srdOnPass(roll)) return `Not set takes the SRD's rule for ${roll.name.trim()}: ${reads} on a pass.`;
  return roll.kind === "spell" && roll.level === 0 ? `Not set takes ${reads} on a pass, as most cantrips do.` : `Not set takes ${reads} on a pass, as most saves that deal damage do.`;
}

/** One part of a roll's dice: its formula, the modifier, its type, a rider's name, and for a spell how it grows. */
function PartFields(props: { roll: PcRoll; part: PcDice; index: number; onChange(part: PcDice): void; onRemove(): void }) {
  const { roll, part, onChange } = props;
  const where = roll.dice.length > 1 ? `Dice ${props.index + 1}` : "Dice";
  const damage = part.type !== undefined && part.type !== "healing";
  const cantrip = roll.kind === "spell" && (roll.level ?? 0) === 0;
  const leveled = roll.kind === "spell" && (roll.level ?? 0) >= 1;
  const flag = (key: "mod" | "grows" | "optional", on: boolean) => {
    const next = { ...part };
    if (on) next[key] = true;
    else delete next[key];
    if (key === "optional" && on && next.name === undefined) next.name = "";
    onChange(next);
  };
  return (
    <fieldset style={{ display: "grid", gap: theme.space(2), border: `${theme.line.border}px solid ${theme.color.border}`, borderRadius: theme.radius.md, padding: theme.space(2), margin: 0, minWidth: 0 }}>
      <legend style={{ fontWeight: theme.weight.strong, padding: `0 ${theme.space(1)}px` }}>{where}</legend>
      <FieldsRow>
        <Labeled label="Formula">
          {(id) => <Input id={id} type="text" value={part.formula} maxLength={40} placeholder="1d8" spellCheck={false} onChange={(e) => onChange({ ...part, formula: e.target.value })} style={{ width: 140 }} />}
        </Labeled>
        <Labeled label="Type">
          {(id) => (
            <Select
              id={id}
              value={part.type ?? ""}
              onChange={(e) => {
                const value = e.target.value as DamageType | "healing" | "";
                const next = { ...part };
                if (value === "") delete next.type;
                else next.type = value;
                onChange(next);
              }}
              style={{ width: 150 }}
            >
              {TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Labeled>
      </FieldsRow>
      <Checkbox label="Add the modifier" checked={part.mod === true} onChange={(on) => flag("mod", on)} />
      {damage ? <Checkbox label="Only sometimes" help="A rider, such as Sneak Attack, rolled only when it applies" checked={part.optional === true} onChange={(on) => flag("optional", on)} /> : null}
      {damage && part.optional ? (
        <Labeled label="Its name">{(id) => <Input id={id} type="text" value={part.name ?? ""} maxLength={30} placeholder="Sneak Attack" onChange={(e) => onChange({ ...part, name: e.target.value })} style={{ width: "100%" }} />}</Labeled>
      ) : null}
      {/* A leveled spell saved with the mark before editedRoll dropped it shows the box too, so the mark can be seen and taken off. */}
      {cantrip || part.grows === true ? <Checkbox label="Grows with level" help="Twice the dice from level 5, three times from 11 and four times from 17" checked={part.grows === true} onChange={(on) => flag("grows", on)} /> : null}
      {leveled && part.type !== undefined ? (
        <Labeled label="At higher levels">
          {(id) => (
            <Input
              id={id}
              type="text"
              value={part.upcast ?? ""}
              maxLength={20}
              placeholder="1d6"
              spellCheck={false}
              onChange={(e) => {
                const next = { ...part };
                if (e.target.value.trim() === "") delete next.upcast;
                else next.upcast = e.target.value;
                onChange(next);
              }}
              style={{ width: "100%" }}
            />
          )}
        </Labeled>
      ) : null}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Button size="sm" variant="quiet" onClick={props.onRemove}>
          Remove these dice
        </Button>
      </div>
    </fieldset>
  );
}

