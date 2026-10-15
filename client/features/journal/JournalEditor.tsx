import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { JournalAccess, JournalPage, Member } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { MAX_NAME } from "#shared/protocol.ts";
import { Button } from "../../components/Button.tsx";
import { Checkbox } from "../../components/Checkbox.tsx";
import { Dialog, DiscardQuestion } from "../../components/Dialog.tsx";
import { Field, Select, TextArea } from "../../components/Field.tsx";
import { Loading } from "../../components/Loading.tsx";
import { Notice } from "../../components/Notice.tsx";
import { Help, Note } from "../../components/Panel.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { ConfirmButton } from "../tokens/ui.tsx";
import { draftDirty, draftOf, emptyDraft, moveBlock, newBlockId, saveAnswer, saveDraft, sizeNote, type PageDraft } from "./draft.ts";
import { closedAnswerText, editDraft, pendingCloseText, saveAnswered, saveNotSent, saveSent, saveState } from "./pendingSave.ts";

const EMPTY_MEMBERS: Record<string, Member> = {};

type AccessMode = "dm" | "all" | "member";

/**
 * A journal page's editor (docs/design-v1-dm-tools.md 3.7), for the DM:
 * full screen on a phone, a dialog from 600 px up. The title, the folder,
 * who can read it, and the blocks, each a text area with a Secret checkbox,
 * move up and down, and delete.
 *
 * The whole page is one draft and Save sends one op, so an edit is one undo
 * step. Leaving with unsaved changes asks once. Whether a secret is revealed
 * is not the editor's: Reveal and Hide on the page itself are their own op.
 *
 * While a save is pending, the fields sit in a disabled fieldset and take
 * the disabled look, and Save, outside it in the footer, shows busy.
 */
export function JournalEditor(props: { page: JournalPage | null; folders: readonly string[]; onClose(): void; onSaved(pageId: string): void }) {
  const actions = useRoomActions();
  const ui = useRoomUi();
  const members = useRoomView((s) => s.view?.members ?? EMPTY_MEMBERS);
  const initial = useMemo(() => (props.page ? draftOf(props.page) : emptyDraft()), [props.page]);
  // The draft locks while a save is pending (pendingSave.ts), so nothing typed then is lost when the acknowledgment closes the editor.
  const [state, setState] = useState(() => saveState<PageDraft>(initial));
  const { draft, pending: saving, failure } = state;
  const setDraft = (change: (d: PageDraft) => PageDraft) => setState((s) => editDraft(s, change));
  const [problems, setProblems] = useState<string[]>([]);
  const [leaving, setLeaving] = useState(false);
  const pageId = useMemo(() => props.page?.id ?? actions.newId(), [props.page, actions]);
  // The page as it stands now: a new page once a save of it went through, or the page after other edits since this one opened.
  const live = useRoomView((s) => s.view?.journal[pageId]);
  const connected = useRoomView((s) => s.connection === "open");
  const folderList = useId();
  const accessLabel = useId();
  const problemsRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const dirty = draftDirty(initial, draft);
  const size = sizeNote(live ?? props.page, draft, pageId);
  const players = Object.values(members)
    .filter((m) => m.kind === "player")
    .sort((a, b) => a.name.localeCompare(b.name));
  const mode: AccessMode = typeof draft.access === "object" ? "member" : draft.access;
  const set = (patch: Partial<PageDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setBlock = (index: number, patch: Partial<PageDraft["blocks"][number]>) =>
    setDraft((d) => ({ ...d, blocks: d.blocks.map((b, i) => (i === index ? { ...b, ...patch } : b)) }));
  const full = draft.blocks.length >= LIMITS.journalBlocksPerPage;

  useEffect(() => {
    if (problems.length > 0 || failure !== null) problemsRef.current?.scrollIntoView({ block: "nearest" });
  }, [problems, failure]);

  // A pending save was sent as it is and still lands, so closing then discards nothing: no question, and a word on where the save stands.
  const close = () => {
    if (saving) {
      ui.notify(pendingCloseText("page", connected));
      props.onClose();
      return;
    }
    if (dirty && !leaving) setLeaving(true);
    else props.onClose();
  };

  /**
   * The draft stays until the server has taken it (draft.ts saveAnswer): a
   * refused page snaps back out of the view, and closing at once would lose
   * everything typed with it. The answer is shown here, not in a toast,
   * which this dialog would cover.
   */
  const save = () => {
    if (saving) return;
    // A new page whose earlier save went through, unheard, is now an edit of that page.
    const result = saveDraft(props.page ?? live ?? null, draft, pageId, live ?? props.page);
    if (result.kind === "invalid") {
      setProblems(result.problems);
      return;
    }
    if (result.kind === "unchanged") {
      props.onSaved(pageId);
      return;
    }
    setProblems([]);
    const n = actions.dispatch(result.op, {
      quiet: true,
      onAnswer: (answer, refusal) => {
        if (!mounted.current) {
          // Closed while pending: no draft is left to show why, so a failure says so in a toast.
          const text = closedAnswerText("page", answer, refusal);
          if (text) ui.notify(text, "error");
          return;
        }
        const outcome = saveAnswer(answer, refusal);
        if (outcome.kind === "saved") {
          props.onSaved(pageId);
          return;
        }
        setState((s) => saveAnswered(s, outcome).state);
      },
    });
    if (n === null) {
      setState((s) => saveNotSent(s, "The page could not be sent. Your text is still here."));
      return;
    }
    setState(saveSent);
  };

  const pickMode = (next: AccessMode) => {
    if (next === mode) return;
    const access: JournalAccess = next === "member" ? { member: players[0]?.id ?? "" } : next;
    set({ access });
  };

  const footer = leaving ? (
    <>
      <Button onClick={() => setLeaving(false)}>Keep editing</Button>
      <Button variant="danger" armed onClick={props.onClose}>
        Discard
      </Button>
    </>
  ) : (
    <>
      <Button onClick={close}>{saving ? "Close" : "Cancel"}</Button>
      <Button variant="primary" busy={saving} onClick={save}>
        {saving ? "Saving…" : "Save"}
      </Button>
    </>
  );
  const status = leaving ? (
    <DiscardQuestion />
  ) : saving ? (
    <Loading text={connected ? "Saving the page…" : "Waiting for the connection to save…"} />
  ) : null;

  return (
    <Dialog title={props.page ? `Edit ${props.page.title}` : "New page"} width="md" phone="fill" onClose={close} footer={footer} status={status}>
      {/* Disabled as a whole while a save is pending: every field, picker and block button at once, as editDraft refuses their edits. */}
      <fieldset disabled={saving} aria-busy={saving} style={{ margin: 0, padding: 0, border: "none", minWidth: 0 }}>
        <div style={{ display: "grid", gap: theme.space(4), fontSize: theme.font.body14 }}>
          {failure !== null ? (
            <div ref={problemsRef}>
              <Notice tone="danger" role="alert">
                {failure}
              </Notice>
            </div>
          ) : null}
          {problems.length > 0 ? (
            <div ref={problemsRef}>
              <Notice tone="danger" role="alert">
                <strong>Fix these first:</strong>
                {problems.map((p) => (
                  <span key={p} style={{ display: "block" }}>
                    {p}
                  </span>
                ))}
              </Notice>
            </div>
          ) : null}
          <Field
            label="Title"
            value={draft.title}
            maxLength={MAX_NAME}
            placeholder="Old map of the crypt"
            autoFocus={props.page === null}
            onChange={(e) => set({ title: e.target.value })}
          />
          <Field
            label="Folder"
            hint="Pages in one folder sit together in the Journal. Leave it empty for none."
            value={draft.folder}
            maxLength={LIMITS.folderNameChars}
            placeholder="No folder"
            list={folderList}
            onChange={(e) => set({ folder: e.target.value })}
          />
          <datalist id={folderList}>
            {props.folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <div style={{ display: "grid", gap: theme.space(2) }}>
            <span id={accessLabel} style={{ fontWeight: theme.weight.strong }}>
              Who can read it
            </span>
            <Segmented<AccessMode>
              labelledBy={accessLabel}
              value={mode}
              options={[
                { value: "dm", label: "DM only" },
                { value: "all", label: "Everyone" },
                { value: "member", label: "One player" },
              ]}
              onChange={pickMode}
            />
            {mode === "member" ? (
              players.length > 0 ? (
                <Select
                  aria-label="The player who can read it"
                  value={typeof draft.access === "object" ? draft.access.member : ""}
                  onChange={(e) => set({ access: { member: e.target.value } })}
                >
                  {players.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <Note>No players have joined yet. Pick DM only or Everyone until they do.</Note>
              )
            ) : null}
            <Help>{mode === "dm" ? "Players do not see this page or any pin linked to it." : mode === "all" ? "Every player can read this page, but not its secrets until you reveal them." : "Only that player and the DM can read it. Secrets stay hidden until you reveal them."}</Help>
          </div>
          <div style={{ display: "grid", gap: theme.space(3) }}>
            <span style={{ fontWeight: theme.weight.strong }}>Text</span>
            <Help>Markdown: **bold**, *italic*, # headings, - lists, 1. numbered lists, &gt; quotes and [links](https://example.com). A secret stays hidden from players until you reveal it on the page.</Help>
            {draft.blocks.map((block, i) => (
              <BlockEditor
                key={block.id}
                index={i}
                count={draft.blocks.length}
                text={block.text}
                secret={block.secret}
                onText={(text) => setBlock(i, { text })}
                onSecret={(secret) => setBlock(i, { secret })}
                onMove={(delta) => setDraft((d) => moveBlock(d, i, delta))}
                onDelete={() => setDraft((d) => ({ ...d, blocks: d.blocks.filter((_, j) => j !== i) }))}
              />
            ))}
            <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
              <Button size="sm" icon="plus" disabled={full} onClick={() => setDraft((d) => ({ ...d, blocks: [...d.blocks, { id: newBlockId(), text: "", secret: false }] }))}>
                Add text
              </Button>
              <Button size="sm" icon="plus" disabled={full} onClick={() => setDraft((d) => ({ ...d, blocks: [...d.blocks, { id: newBlockId(), text: "", secret: true }] }))}>
                Add a secret
              </Button>
            </div>
            {full ? <Help>A page holds at most {LIMITS.journalBlocksPerPage} blocks.</Help> : null}
            {size ? (
              size.over ? (
                <p role="alert" style={{ margin: 0, fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.dangerText }}>
                  {size.text}
                </p>
              ) : (
                <Help>{size.text}</Help>
              )
            ) : null}
          </div>
        </div>
      </fieldset>
    </Dialog>
  );
}

function BlockEditor(props: {
  index: number;
  count: number;
  text: string;
  secret: boolean;
  onText(text: string): void;
  onSecret(secret: boolean): void;
  onMove(delta: -1 | 1): void;
  onDelete(): void;
}) {
  const n = props.index + 1;
  const long = props.text.length > LIMITS.journalBlockChars * 0.9;
  return (
    <section
      aria-label={props.secret ? `Secret block ${n}` : `Block ${n}`}
      style={{
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: props.secret ? `${theme.line.strong}px dashed ${theme.color.warning}` : `${theme.line.border}px solid ${theme.color.border}`,
        background: theme.color.bg,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1), flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 120px" }}>
          <Checkbox checked={props.secret} onChange={props.onSecret} label="Secret" />
        </div>
        <Button size="sm" aria-label={`Move block ${n} up`} title={`Move block ${n} up`} disabled={props.index === 0} onClick={() => props.onMove(-1)}>
          ↑
        </Button>
        <Button size="sm" aria-label={`Move block ${n} down`} title={`Move block ${n} down`} disabled={props.index === props.count - 1} onClick={() => props.onMove(1)}>
          ↓
        </Button>
        <ConfirmButton label={`Delete block ${n}`} confirm="Delete it?" onConfirm={props.onDelete}>
          Delete
        </ConfirmButton>
      </div>
      <TextArea
        aria-label={props.secret ? `Secret block ${n} text` : `Block ${n} text`}
        value={props.text}
        maxLength={LIMITS.journalBlockChars}
        rows={5}
        placeholder={props.secret ? "What players learn when you reveal it" : "What the page says"}
        onChange={(e) => props.onText(e.target.value)}
        style={{ width: "100%" }}
      />
      {long ? (
        <Help>
          {props.text.length.toLocaleString("en-US")} of {LIMITS.journalBlockChars.toLocaleString("en-US")} characters. Add another block for more.
        </Help>
      ) : null}
    </section>
  );
}
