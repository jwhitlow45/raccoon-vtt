import { useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import type { InitEntry } from "#shared/model.ts";
import { MAX_ENTRIES_PER_OP } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Help } from "../../components/Panel.tsx";
import { useUnsavedSince } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomView } from "../../state/view.ts";
import { entryName, groupEntries, valueChanges, valueText, type ValueField } from "./logic.ts";
import { Portrait } from "./parts.tsx";

/**
 * The DM types every roll in one pass and saves them with one
 * `encounter.setValues` (design 9.4). Identical monsters share one box by
 * default, since many tables roll once for a group. "Split" gives each of
 * them its own box. Only boxes the DM touched are saved, so a group whose
 * rows already hold different values is never flattened by accident.
 */
export function ValueEntry(props: { entries: InitEntry[]; onDone(): void }) {
  const { entries } = props;
  const actions = useRoomActions();
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const view = useMemo(() => ({ tokens: tokens ?? {}, characters: characters ?? {} }), [tokens, characters]);
  const [split, setSplit] = useState<ReadonlySet<string>>(new Set());
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Only Save sends the values typed, so a sheet's swipe springs back while any is typed (docs/design-v1-sheet-swipe.md 4.5).
  useUnsavedSince(texts);
  const byId = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);

  const fields = useMemo(() => {
    const out: (ValueField & { label: string; first: InitEntry; count: number })[] = [];
    for (const group of groupEntries(entries)) {
      const rows = group.entryIds.map((id) => byId.get(id)!).filter(Boolean);
      const first = rows[0];
      if (!first) continue;
      if (rows.length > 1 && !split.has(group.key)) {
        const shared = rows.every((r) => r.value === first.value) ? valueText(first.value) : "";
        const token = first.tokenId !== undefined ? view.tokens[first.tokenId] : undefined;
        const base = token?.name ?? entryName(view, first);
        out.push({ key: group.key, entryIds: group.entryIds, text: texts[group.key] ?? shared, label: base, first, count: rows.length });
        continue;
      }
      for (const row of rows) {
        const key = `entry:${row.id}`;
        out.push({ key, entryIds: [row.id], text: texts[key] ?? valueText(row.value), label: entryName(view, row), first: row, count: 1 });
      }
    }
    return out;
  }, [entries, byId, split, texts, view]);

  const save = (e?: FormEvent) => {
    e?.preventDefault();
    const touched = fields.filter((f) => texts[f.key] !== undefined);
    const result = valueChanges(touched, (id) => byId.get(id)?.value ?? null);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) return;
    for (let i = 0; i < result.values.length; i += MAX_ENTRIES_PER_OP) {
      actions.dispatch({ t: "encounter.setValues", values: result.values.slice(i, i + MAX_ENTRIES_PER_OP) });
    }
    props.onDone();
  };

  // Enter moves to the next box, like a spreadsheet, and saves after the last one.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const inputs = [...(e.currentTarget.form?.querySelectorAll("input") ?? [])];
    const next = inputs[inputs.indexOf(e.currentTarget) + 1];
    if (next) next.focus();
    else save();
  };

  return (
    <form onSubmit={save} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}>
      <Help>Type each roll as rolled. Leave a box empty to clear it.</Help>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
        {fields.map((field) => (
          <li key={field.key} style={{ display: "flex", alignItems: "center", gap: theme.space(2), minHeight: 52 }}>
            <Portrait entry={field.first} size={32} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontWeight: theme.weight.strong, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {field.label}
                {field.count > 1 ? <span style={{ color: theme.color.textMuted, fontWeight: theme.weight.regular }}> ({field.count} share one roll)</span> : null}
              </span>
              {errors[field.key] ? (
                <span role="alert" style={{ display: "block", color: theme.color.dangerText, fontSize: theme.font.small }}>
                  {errors[field.key]}
                </span>
              ) : null}
            </span>
            {field.count > 1 ? (
              <Button size="sm" onClick={() => setSplit(new Set([...split, field.key]))} aria-label={`Give each ${field.label} its own roll`}>
                Split
              </Button>
            ) : null}
            <Button
              size="sm"
              aria-label={`Flip the sign for ${field.label}`}
              onClick={() => {
                const t = field.text.trim();
                setTexts({ ...texts, [field.key]: t.startsWith("-") ? t.slice(1) : `-${t}` });
              }}
              style={{ padding: 0, fontSize: theme.font.input }}
            >
              ±
            </Button>
            <Input
              aria-label={`${field.label} Initiative`}
              error={!!errors[field.key]}
              inputMode="numeric"
              enterKeyHint="next"
              autoComplete="off"
              value={field.text}
              onChange={(e) => setTexts({ ...texts, [field.key]: e.target.value })}
              onKeyDown={onKeyDown}
              style={{ width: 60, padding: `0 ${theme.space(1)}px`, textAlign: "center", fontVariantNumeric: "tabular-nums" }}
            />
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: theme.space(2), justifyContent: "flex-end" }}>
        <Button size="sm" onClick={props.onDone}>
          Cancel
        </Button>
        {/* Secondary: the tracker's one primary is Next, which stays in view above this form (docs/design-v1-visual.md 3.3). */}
        <Button size="sm" type="submit">
          Save values
        </Button>
      </div>
    </form>
  );
}
