import { pcShape } from "#shared/rules/pcStats.ts";
import { useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Character } from "#shared/model.ts";
import { MAX_KNOWN_FORMS } from "#shared/protocol.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { ErrorText, Input, Select } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Help, Note, SectionLabel } from "../../components/Panel.tsx";
import { Row } from "../../components/Row.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { UnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { MonsterList, MonsterRow, ROWS, type ListedRow } from "../monsters/MonsterList.tsx";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { SrdCredit, useSrdMonsters } from "../monsters/StatBlockView.tsx";
import { editsPcStats } from "../tokens/access.ts";
import { whose } from "../tokens/companionBlocks.ts";
import { SmallButton } from "../tokens/ui.tsx";
import { monsterMatcher } from "../tokens/monsterSearch.ts";
import { formLabel, formMark, knownFormCountWords, isCurrentForm, knownFormPatch, knownFormsIn, missingFormText, rememberDruidLevel, rememberedDruidLevel, startDruidLevel, toggleKnownForm } from "./knownForms.ts";
import { byCrThenName, DRUID_LEVELS, fitsShapeLimit, shapeLimit } from "./shapeLevel.ts";
import { shapePatch, shapeTempHp, wildShapeDetail, type ShapeKind } from "./shape.ts";

/** Whether an SRD creature is a Beast, which Wild Shape and Polymorph take. */
function isBeast(m: SrdMonster): boolean {
  return /^beast\b/i.test(m.type.trim());
}

/**
 * "Take a shape" (docs/design-v1-pc-stats.md 7.3): the SRD's creatures with
 * the Beasts filtered in, then one step that says what the shape keeps,
 * Wild Shape by default, and Take the shape, one `character.update` on the
 * character's own actor with the creature's AC and speeds and the shape's
 * temporary HP, a checkbox on by default (W7B-P-9). HP stays the
 * character's.
 *
 * A Druid's known forms come first, each taking Wild Shape in one tap, and
 * "Change" opens the step that chooses them, sharing the search and both
 * filters with the first page (docs/design-v1-known-forms.md 5.1 and 5.2).
 *
 * A druid in Wild Shape reaches it from the row's button too: the form she
 * is in shows pressed and does nothing when tapped, the rest change her form,
 * and only Wild Shape is offered, since Polymorph waits for End the shape
 * (D-261024-29, D-261024-32).
 */
export function ShapePicker(props: { character: Pick<Character, "id" | "name" | "level" | "actor" | "ownerIds" | "stats" | "knownForms">; onClose(): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const roomId = useRoomView((s) => s.roomId);
  const characterId = props.character.id;
  const { monsters, failed } = useSrdMonsters();
  const [query, setQuery] = useState("");
  const [beastsOnly, setBeastsOnly] = useState(true);
  // The Druid level this device remembers for the character, null for Any, which Wild Shape's Temporary HP follow (5.5).
  const [remembered, setRemembered] = useState(() => rememberedDruidLevel(roomId, characterId));
  const [druidLevel, setDruidLevel] = useState<number | null>(() => startDruidLevel(remembered, props.character));
  const [picked, setPicked] = useState<SrdMonster | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [kind, setKind] = useState<ShapeKind>("wild");
  const inWildShape = pcShape(props.character) === "wild";
  const [gainTemp, setGainTemp] = useState(true);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The known forms step's list, its count line, and the row a toggle took the focus from, for when that row leaves the list (refocusAfterToggle).
  const formsList = useRef<HTMLUListElement>(null);
  const countLine = useRef<HTMLDivElement>(null);
  const toggled = useRef<Toggled | null>(null);
  const deferred = useDeferredValue(query);
  const matches = useMemo(() => monsterMatcher(deferred), [deferred]);
  const limit = useMemo(() => (druidLevel === null ? null : shapeLimit(druidLevel)), [druidLevel]);
  const filtered = useMemo(() => {
    const kept = (monsters ?? []).filter((m) => (!beastsOnly || isBeast(m)) && matches(m) && (limit === null || fitsShapeLimit(limit, m)));
    if (limit !== null) kept.sort(byCrThenName);
    return kept;
  }, [monsters, beastsOnly, matches, limit]);
  const knownIds = props.character.knownForms;
  const known = useMemo(() => knownFormsIn(knownIds, monsters ?? []), [knownIds, monsters]);
  // Once the toggled list shows, which the prediction does in the same task as the tap.
  useLayoutEffect(() => {
    const was = toggled.current;
    toggled.current = null;
    if (was && formsList.current) refocusAfterToggle(formsList.current, was, countLine.current);
  }, [knownIds]);
  const count = knownFormCountWords(knownIds?.length ?? 0, druidLevel);
  // Wild Shape forms must be Beasts, so choosing a level turns the filter on. It stays the user's to turn off again.
  const chooseLevel = (value: string) => {
    const level = value === "" ? null : Number(value);
    setDruidLevel(level);
    if (level !== null) setBeastsOnly(true);
    rememberDruidLevel(roomId, characterId, level);
    setRemembered(level);
  };
  const name = props.character.name;
  const you = useRoomView((s) => s.you);

  // One search and one pair of filters for both pages, so a level picked on either carries to the other (5.2).
  const filters = (
    <>
      <Input type="search" aria-label="Search creatures" placeholder="Search: wolf, cr 0-1" value={query} enterKeyHint="search" onChange={(e) => setQuery(e.target.value)} style={{ width: "100%" }} />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(4), rowGap: theme.space(1) }}>
        <Checkbox label="Beasts only" checked={beastsOnly} onChange={setBeastsOnly} />
        <label style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
          Druid level
          <Select value={druidLevel === null ? "" : String(druidLevel)} onChange={(e) => chooseLevel(e.target.value)}>
            <option value="">Any</option>
            {DRUID_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {limit ? <Help>{limit.label}</Help> : null}
      {failed ? <SrdLoadFailed what="The creature list" /> : null}
      {!monsters && !failed ? <Loading text="Loading the creatures…" /> : null}
    </>
  );

  // A refused toggle's words, on whichever page is open when the answer comes, so going Back never hides one (5.2).
  const refusalLine = <ErrorText>{refusal}</ErrorText>;
  // Back and Change clear it, so a page never opens on an old refusal.
  const leaving = (go: () => void) => () => {
    setRefusal(null);
    go();
  };

  if (picked) {
    const temp = shapeTempHp(kind, props.character, picked, remembered ?? undefined);
    const holding = props.character.actor.hp.temp;
    const take = () => {
      const patch = shapePatch(picked, kind, props.character, gainTemp ? temp : undefined);
      if (actions.dispatch({ t: "character.update", characterId, patch: { actor: patch } }) !== null) props.onClose();
    };
    const druidWords = typeof remembered === "number" ? `Druid level ${remembered}, as picked in Take a shape.` : `The Druid level, read as ${whose(name)} level.`;
    return (
      <Dialog
        title={`Take the shape of ${picked.name}`}
        onClose={props.onClose}
        back={{ label: "Back to the creatures", onBack: leaving(() => setPicked(null)) }}
        phone="sheet"
        width="md"
        footer={
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" onClick={take}>
              Take the shape
            </Button>
          </>
        }
      >
        {/* Its step rises from the bottom on a phone, so a shape other than Wild Shape, which only Take the shape sends, holds it against a swipe (docs/design-v1-sheet-swipe.md 4.6). */}
        <UnsavedInput unsaved={kind !== "wild" || !gainTemp} />
        <div style={{ display: "grid", gap: theme.space(2), fontSize: theme.font.body14 }}>
          {refusalLine}
          {inWildShape ? (
            <Help>{wildShapeDetail(props.character, picked.name, editsPcStats(you, props.character))}</Help>
          ) : (
            <ShapeChoice name={name} creature={picked.name} wild={wildShapeDetail(props.character, picked.name, editsPcStats(you, props.character))} value={kind} onChange={setKind} />
          )}
          {holding >= temp ? (
            <Help>{`${whose(name)} ${holding} Temporary HP stay, as they are no fewer than the ${temp} the shape gives.`}</Help>
          ) : (
            <Checkbox
              label={`Gain ${temp} Temporary HP (${kind === "wild" ? "Wild Shape" : "Polymorph"})`}
              help={kind === "wild" ? druidWords : `${whose(picked.name)} HP. What is left of them goes when the shape ends.`}
              checked={gainTemp}
              onChange={setGainTemp}
            />
          )}
          <Help>{`The token takes ${whose(picked.name)} AC and Speeds until the shape ends, then ${whose(name)} own come back. It keeps ${whose(name)} HP, conditions and Passive Perception in either shape.`}</Help>
        </div>
      </Dialog>
    );
  }

  if (choosing) {
    const full = (knownIds?.length ?? 0) >= MAX_KNOWN_FORMS;
    const chosen = new Set(knownIds ?? []);
    // The known forms first, whatever the search and the level, so a marked one can still be taken out (5.2).
    const knownRows = known.forms.map((m): ListedRow => ({ key: m.srdId, view: m, source: "srd", tag: formMark(limit, m)?.tag, pressed: true }));
    const otherRows = filtered.filter((m) => !chosen.has(m.srdId)).map((m): ListedRow => ({ key: m.srdId, view: m, source: "srd", pressed: false, disabled: full }));
    // Each tap sends the whole new list, as a condition's toggle sends its op: the prediction shows it at once, with no Save.
    const toggle = (srdId: string) => {
      setRefusal(null);
      const knownForms = toggleKnownForm(props.character.knownForms, srdId);
      const rows = formsList.current ? formRows(formsList.current) : [];
      const index = rows.findIndex((b) => b.parentElement?.dataset.form === srdId);
      toggled.current = index >= 0 && rows[index] === document.activeElement ? { key: srdId, index } : null;
      // Quiet, so a refusal shows in the server's words on the open page rather than in a toast behind the dialog.
      const sent = actions.dispatch(
        { t: "character.update", characterId, patch: { knownForms } },
        {
          quiet: true,
          onAnswer: (answer, why) => {
            if (answer !== "refused" || !why) return;
            if (mounted.current) setRefusal(why.text);
            else ui.notify(why.text, "error");
          },
        },
      );
      if (sent === null) toggled.current = null;
    };
    const rowItem = (m: ListedRow) => (
      <li key={m.key} data-form={m.key}>
        <MonsterRow item={m} onPick={toggle} />
      </li>
    );
    return (
      <Dialog
        title={`${whose(name)} known forms`}
        onClose={props.onClose}
        back={{ label: "Back to the creatures", onBack: leaving(() => setChoosing(false)) }}
        phone="fill"
        width="md"
      >
        <PickerBody>
          <Help>{`The Beast forms ${name} knows for Wild Shape, listed first in Take a shape. By the rules a Druid replaces one after each Long Rest, and the DM may allow other Beasts.`}</Help>
          {/* Where the focus goes when a toggled row leaves the list and no row follows it. */}
          <div ref={countLine} tabIndex={-1} style={{ outline: "none" }}>
            {count.over ? <Note>{count.text}</Note> : <Help>{count.text}</Help>}
          </div>
          {refusalLine}
          {filters}
          {monsters ? (
            <>
              {/*
                One flat keyed array. React scopes keys to each array, so with three arrays a row that moved between the known
                forms and the rest, on a toggle or a refusal's rollback, was mounted anew and its keyboard focus fell to the page.
                In one array React moves the row and gives a moved row its focus back itself.
              */}
              <ul ref={formsList} style={ROWS}>
                {[
                  ...knownRows.map(rowItem),
                  ...known.missing.map((id) => (
                    <li key={id} data-form={id}>
                      <Row pressed onClick={() => toggle(id)} title={id} detail="Not in this app's SRD list" />
                    </li>
                  )),
                  ...otherRows.map(rowItem),
                ]}
              </ul>
              {otherRows.length === 0 ? <Help>No other creature matches.</Help> : null}
            </>
          ) : null}
          <SrdCredit />
        </PickerBody>
      </Dialog>
    );
  }

  const takeForm = (srdId: string) => {
    const m = monsters?.find((x) => x.srdId === srdId);
    if (!m || isCurrentForm(props.character, srdId)) return;
    if (actions.dispatch({ t: "character.update", characterId, patch: { actor: knownFormPatch(m, props.character, remembered) } }) !== null) props.onClose();
  };
  const knownRows = known.forms.map((m): ListedRow => {
    const mark = formMark(limit, m);
    const current = isCurrentForm(props.character, m.srdId);
    return { key: m.srdId, view: m, source: "srd", tag: mark?.tag, label: formLabel(m.name, mark), ...(current ? { pressed: true, disabled: true } : {}) };
  });
  const none = (knownIds?.length ?? 0) === 0;
  return (
    <Dialog title="Take a shape" onClose={props.onClose} phone="fill" width="md">
      <PickerBody>
        <Help>{`An SRD creature for ${whose(name)} token to take the shape of. The token keeps ${whose(name)} HP and conditions.`}</Help>
        {refusalLine}
        {/* The rows need the SRD list's names, AC and speeds, so the group waits under the list's own loading and failure lines (5.1). */}
        {monsters ? (
          <div style={{ display: "grid", gap: theme.space(2) }}>
            <SectionLabel
              action={
                <>
                  {none ? null : <span style={{ fontSize: theme.font.small, color: count.over ? theme.color.warning : theme.color.textMuted, whiteSpace: "nowrap" }}>{count.short}</span>}
                  <SmallButton wrap onClick={leaving(() => setChoosing(true))}>
                    {none ? "Choose known forms" : "Change"}
                  </SmallButton>
                </>
              }
            >
              Known forms
            </SectionLabel>
            {none ? <Help>{noFormsText(name)}</Help> : <MonsterList items={knownRows} onPick={takeForm} />}
            {known.missing.map((id) => (
              <Help key={id}>{missingFormText(id)}</Help>
            ))}
          </div>
        ) : null}
        {filters}
        {monsters ? <SectionLabel>All creatures</SectionLabel> : null}
        <MonsterList items={filtered.map((m): ListedRow => ({ key: m.srdId, view: m, source: "srd" }))} onPick={(key) => setPicked(monsters?.find((m) => m.srdId === key) ?? null)} />
        {monsters && filtered.length === 0 ? <Help>No creature matches.</Help> : null}
        <SrdCredit />
      </PickerBody>
    </Dialog>
  );
}

/** What a druid's known forms read with none chosen yet, in Take a shape. */
function noFormsText(name: string): string {
  return `${name} knows no forms yet. A Druid knows 4 Beast forms at level 2, 6 at level 4 and 8 at level 8.`;
}

/** The known forms step's row buttons, in order. */
function formRows(list: HTMLElement): HTMLButtonElement[] {
  return [...list.querySelectorAll<HTMLButtonElement>("li[data-form] > button")];
}

/** The row a toggle took the focus from: its key, and where it stood among the rows. */
type Toggled = { key: string; index: number };

/**
 * Gives the keyboard's focus a place after a toggle lost it to the page
 * (5.2). A known form the filters drop leaves the list, such as the Owl at
 * Druid level 4, and the row now in its place takes it, else the count. A
 * row that only moved keeps its focus, since React gives a moved element
 * its focus back, so finding the toggled row by key is a safety net.
 */
function refocusAfterToggle(list: HTMLElement, was: Toggled, count: HTMLElement | null): void {
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  const rows = formRows(list);
  const target = rows.find((b) => b.parentElement?.dataset.form === was.key) ?? rows.slice(was.index).find((b) => !b.disabled) ?? count;
  target?.focus();
}

/** Each page's body: one column no wider than the dialog, so a long name cuts or wraps rather than scroll it sideways. */
function PickerBody(props: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14, overflowWrap: "anywhere" }}>{props.children}</div>;
}

/** Wild Shape or another shape, as two radios each 44 px tall, whose words say what the shape keeps. */
function ShapeChoice(props: { name: string; creature: string; wild: string; value: ShapeKind; onChange(kind: ShapeKind): void }) {
  const group = useId();
  const options: { value: ShapeKind; label: string; detail: string }[] = [
    { value: "wild", label: "Wild Shape", detail: props.wild },
    { value: "other", label: "Polymorph or another shape", detail: `All of ${props.creature}'s numbers.` },
  ];
  return (
    <div role="radiogroup" aria-label="Which shape" style={{ display: "grid", gap: theme.space(1) }}>
      {options.map((o) => (
        <label key={o.value} style={{ display: "flex", alignItems: "flex-start", gap: theme.space(3), minHeight: theme.touch, padding: `${theme.space(2)}px 0`, cursor: "pointer" }}>
          <input type="radio" name={group} value={o.value} checked={props.value === o.value} onChange={() => props.onChange(o.value)} style={{ width: 22, height: 22, margin: 0, flex: "none", accentColor: theme.color.accent }} />
          <span style={{ display: "grid", gap: theme.space(1) }}>
            <strong>{o.label}</strong>
            <span style={{ color: theme.color.textMuted }}>{o.detail}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
