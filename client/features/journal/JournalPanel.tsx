import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { JournalBlock, JournalPage, Member } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Help } from "../../components/Panel.tsx";
import { Row } from "../../components/Row.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { usePanelHeader, type PanelProps } from "../panels.ts";
import { pinSlot } from "../pins/store.ts";
import { ConfirmButton } from "../tokens/ui.tsx";
import { accessText, groupPages } from "./draft.ts";
import { JournalEditor } from "./JournalEditor.tsx";
import { journalSlot, readCollapsedFolders, useJournalSeen, writeCollapsedFolders } from "./store.ts";

const EMPTY_PAGES: Record<string, JournalPage> = {};
const EMPTY_MEMBERS: Record<string, Member> = {};

/**
 * The Journal panel (docs/design-v1-dm-tools.md 3.7), for everyone: pages
 * in folders, sorted by title. The DM writes them, chooses who reads each
 * (only the DM, everyone, or one player), and reveals secret blocks one at
 * a time. A player sees the pages shared with them, with revealed secrets
 * as ordinary text, and a New or Updated tag on what changed since they
 * last read it.
 *
 * Which page is open lives in the Room's scope (store.ts), so a tap on a
 * map pin can open its page here. An open page is the panel's subpage: the
 * sheet or side panel titles its header with the page's title and puts
 * "Back to Journal" there (usePanelHeader).
 */
export default function JournalPanel(props: PanelProps) {
  const role = useRoomView((s) => s.you?.role ?? "player");
  const pages = useRoomView((s) => s.view?.journal ?? EMPTY_PAGES);
  const open = useScoped(journalSlot);
  const pageId = useStore(open, (s) => s.pageId);
  const [editing, setEditing] = useState<{ page: JournalPage | null } | null>(null);
  const page = pageId !== null ? pages[pageId] : undefined;
  const folders = useMemo(() => [...new Set(Object.values(pages).flatMap((p) => (p.folder === undefined ? [] : [p.folder])))].sort(), [pages]);
  const dm = role === "dm";
  const back = () => open.setState({ pageId: null });
  usePanelHeader(
    page
      ? {
          title: page.title,
          parent: "Journal",
          id: page.id,
          onBack: back,
        }
      : null,
  );

  const editor = editing ? (
    <JournalEditor
      page={editing.page}
      folders={folders}
      onClose={() => setEditing(null)}
      onSaved={(id) => {
        setEditing(null);
        open.setState({ pageId: id });
      }}
    />
  ) : null;

  if (page) {
    return (
      <>
        <PageView page={page} dm={dm} shown={props.shown} onBack={back} onEdit={() => setEditing({ page })} close={props.close} />
        {editor}
      </>
    );
  }
  return (
    <>
      <PageList pages={pages} dm={dm} onOpen={(id) => open.setState({ pageId: id })} onNew={() => setEditing({ page: null })} />
      {editor}
    </>
  );
}

function PageList(props: { pages: Record<string, JournalPage>; dm: boolean; onOpen(id: string): void; onNew(): void }) {
  const { dm } = props;
  const roomId = useRoomView((s) => s.roomId);
  const members = useRoomView((s) => s.view?.members ?? EMPTY_MEMBERS);
  const { unread, seen } = useJournalSeen();
  const [collapsed, setCollapsed] = useState(() => readCollapsedFolders(roomId));
  const list = Object.values(props.pages);
  const groups = useMemo(() => groupPages(list), [props.pages]);
  const full = list.length >= LIMITS.journalPagesPerRoom;

  const toggle = (folder: string) => {
    const next = new Set(collapsed);
    if (!next.delete(folder)) next.add(folder);
    setCollapsed(next);
    writeCollapsedFolders(roomId, next);
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      {dm ? (
        <div style={{ display: "grid", gap: theme.space(1) }}>
          {/* Saving a new page opens it, so Back from there finds this button by its id (features/panels.ts useSubpageFocus). */}
          <Button variant="primary" size="sm" block disabled={full} onClick={props.onNew} data-opener="journal-new">
            New page
          </Button>
          {list.length >= LIMITS.journalPagesPerRoom * 0.9 ? (
            <Help>
              {list.length} of {LIMITS.journalPagesPerRoom} pages
            </Help>
          ) : null}
        </div>
      ) : null}
      {list.length === 0 ? (
        <Empty>{dm ? "No pages yet. A page can be notes for you alone, something for every player to read, or a note for one player." : "No pages yet. Pages the DM shares with you show here."}</Empty>
      ) : null}
      {groups.map((group) => {
        const rows = group.pages.map((page) => (
          <PageRow
            key={page.id}
            id={page.id}
            title={page.title}
            detail={dm ? accessText(page.access, members) : null}
            mark={unread.has(page.id) ? (seen[page.id] ? "Updated" : "New") : null}
            onOpen={() => props.onOpen(page.id)}
          />
        ));
        if (group.folder === null) return <div key="" style={{ display: "grid", gap: theme.space(1) }}>{rows}</div>;
        const shut = collapsed.has(group.folder);
        const fresh = group.pages.filter((p) => unread.has(p.id)).length;
        return (
          <div key={`folder:${group.folder}`} style={{ display: "grid", gap: theme.space(1) }}>
            <button
              type="button"
              aria-expanded={!shut}
              onClick={() => toggle(group.folder!)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: theme.space(2),
                minHeight: theme.touch,
                marginTop: theme.space(2),
                padding: `0 ${theme.space(1)}px`,
                border: "none",
                borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
                background: "transparent",
                color: theme.color.text,
                fontFamily: theme.font.body,
                fontSize: theme.font.body14,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <Icon name={shut ? "chevronRight" : "chevronDown"} size="sm" style={{ color: theme.color.textMuted }} />
              <span style={{ flex: 1, minWidth: 0, fontWeight: theme.weight.bold, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.folder}</span>
              <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
                {group.pages.length} {group.pages.length === 1 ? "page" : "pages"}
                {fresh > 0 ? ` · ${fresh} new` : ""}
              </span>
            </button>
            {shut ? null : rows}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A page as a card row: its title, who reads it for the DM, and a Tag when
 * it is new or changed since this viewer read it. Back from the page finds
 * the row by the page's id, not its text: reading the page drops its Tag,
 * a rename changes its title and moves it, and two pages can share a title.
 */
export function PageRow(props: { id: string; title: string; detail: string | null; mark: "New" | "Updated" | null; onOpen(): void }) {
  return (
    <Row
      title={props.title}
      detail={props.detail ?? undefined}
      trailing={props.mark ? <Tag tone="turn">{props.mark}</Tag> : undefined}
      opener={`journal-${props.id}`}
      onClick={props.onOpen}
    />
  );
}

function PageView(props: { page: JournalPage; dm: boolean; shown: boolean; onBack(): void; onEdit(): void; close(): void }) {
  const { page, dm } = props;
  const actions = useRoomActions();
  const members = useRoomView((s) => s.view?.members ?? EMPTY_MEMBERS);
  const { markRead } = useJournalSeen();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const sceneShown = useRoomView((s) => s.sceneId !== null);

  // A page on screen is read, and stays read as it changes under the reader's eyes. A hidden sheet or side panel keeps it mounted, and what changed meanwhile counts as unread until it shows again.
  useEffect(() => {
    if (props.shown) markRead(page);
  }, [page, props.shown]);

  const reveal = (block: JournalBlock, revealed: boolean) => actions.dispatch({ t: "journal.reveal", pageId: page.id, blockId: block.id, revealed });
  const remove = () => {
    if (actions.dispatch({ t: "journal.delete", pageId: page.id }) !== null) props.onBack();
  };
  // The phone's sheet closes first, so the map is free for the tap that places the pin (section 3.7).
  const pinToMap = () => {
    props.close();
    scope.get(pinSlot).store.setState({ placing: { pageId: page.id, title: page.title }, paneId: null });
    ui.setTool("pin");
  };

  return (
    // The page's title is the sheet's or side panel's header, so the body opens with who reads it and its folder.
    <article style={{ display: "grid", gap: theme.space(2) }}>
      {dm || page.folder !== undefined ? (
        <Help>{[dm ? accessText(page.access, members) : null, page.folder !== undefined ? `In ${page.folder}` : null].filter(Boolean).join(" · ")}</Help>
      ) : null}
      {dm ? (
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button size="sm" onClick={props.onEdit}>
            Edit
          </Button>
          <Button size="sm" disabled={!sceneShown} onClick={pinToMap}>
            Pin to the map
          </Button>
          <ConfirmButton label="Delete page" confirm="Delete the page?" onConfirm={remove}>
            Delete
          </ConfirmButton>
        </div>
      ) : null}
      {page.blocks.length === 0 ? <Empty>{dm ? "This page is empty. Edit adds text." : "This page is empty."}</Empty> : null}
      {page.blocks.map((block) =>
        dm && block.secret ? (
          <SecretBlock key={block.id} revealed={block.secret.revealed} onReveal={(on) => reveal(block, on)}>
            <Markdown journal text={block.text} style={READING} />
          </SecretBlock>
        ) : (
          <Markdown key={block.id} journal text={block.text} style={READING} />
        ),
      )}
      {dm ? <Help>Deleting a page makes every pin linked to it DM only. Undo brings both back.</Help> : null}
    </article>
  );
}

const READING = { fontSize: theme.font.body14, lineHeight: 1.5 } as const;

/**
 * A secret block as the DM reads it: a dashed edge, and whether players see
 * it, with the one button that changes that. Reveal and Hide are their own
 * op, so an edit saved from an older draft never undoes one.
 */
function SecretBlock(props: { revealed: boolean; onReveal(revealed: boolean): void; children: ReactNode }) {
  return (
    <section
      aria-label={props.revealed ? "Revealed secret" : "Secret"}
      style={{
        display: "grid",
        gap: theme.space(1),
        padding: `${theme.space(2)}px ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.strong}px dashed ${props.revealed ? theme.color.border : theme.color.warning}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), flexWrap: "wrap" }}>
        <span style={{ flex: 1, fontSize: theme.font.small, fontWeight: theme.weight.bold, color: props.revealed ? theme.color.textMuted : theme.color.warning }}>
          {props.revealed ? "Revealed" : "Players don't see this"}
        </span>
        <Button size="sm" onClick={() => props.onReveal(!props.revealed)}>
          {props.revealed ? "Hide" : "Reveal"}
        </Button>
      </div>
      {props.children}
    </section>
  );
}
