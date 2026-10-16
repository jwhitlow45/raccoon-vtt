import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { handoutPages } from "#shared/handouts.ts";
import type { Handout } from "#shared/model.ts";
import { Button } from "../components/Button.tsx";
import { Section } from "../components/Panel.tsx";
import { Row, RowList } from "../components/Row.tsx";
import { closedSlot, openHandout } from "../features/handouts/closed.ts";
import { pageCountText, showingKey, viewerPagesOf } from "../features/handouts/handouts.ts";
import { HandoutViewer } from "../features/handouts/HandoutViewer.tsx";
import { LibraryGrid } from "../features/images/LibraryGrid.tsx";
import type { PanelProps } from "../features/panels.ts";
import { theme } from "../lib/theme.ts";
import { useScoped } from "../state/scope.ts";
import { useAssets, useRoomView } from "../state/view.ts";

/**
 * The room's image library: the image picker's Library grid, to look at
 * only, so each role sees what the picker offers it (design 11.2): a
 * player their own uploads and the token images in their view, the DM
 * every one. Images are added and used from the picker, which the empty
 * library says. For a player the panel also lists the handouts the DM is
 * showing them, so one closed by mistake can be opened again (features
 * section 16).
 */
export default function LibraryPanel(props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  const roomId = useRoomView((s) => s.roomId);
  const root = useRef<HTMLDivElement>(null);
  return (
    <div ref={root} style={{ display: "grid", gap: theme.space(3) }}>
      {role === "player" ? <ShowingHandouts close={props.close} panel={root} /> : null}
      <LibraryGrid
        roomId={roomId}
        empty="No images yet. Add one with the image picker of a token or a character."
        hint="Images are added with the image picker of a token or a character."
      />
    </div>
  );
}

function ShowingHandouts(props: { close(): void; panel: RefObject<HTMLDivElement | null> }) {
  const handouts = useRoomView((s) => s.view?.handouts);
  const assets = useAssets();
  const closedStore = useScoped(closedSlot);
  const showing = useMemo(
    () => Object.values(handouts ?? {}).filter((h): h is Handout => h !== undefined).sort((a, b) => (a.shownAt < b.shownAt ? 1 : -1)),
    [handouts],
  );
  // A thumbnail opens its handout in the viewer at the showing's own key, as the popup does, so both keep one page (the project owner, 2026-10-16).
  const [viewingId, setViewingId] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const viewed = viewingId ? handouts?.[viewingId] : undefined;
  const pages = useMemo(() => (viewed ? viewerPagesOf(viewed.title, handoutPages(viewed), (id, variant) => assets.url(id, variant)) : null), [viewed, assets]);
  const { panel } = props;
  // The DM closed it meanwhile: the viewer closes, and focus goes on in the panel once its row has gone too.
  useEffect(() => {
    if (!viewingId || viewed) return;
    setViewingId(null);
    setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      panel.current?.querySelector<HTMLElement>("button, input, [href]")?.focus();
    }, 0);
  }, [viewingId, viewed, panel]);
  if (showing.length === 0) return null;
  return (
    <Section label="Handouts from the DM" divider={false} style={{ borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
      <RowList>
        {showing.map((h) => (
          <Row
            key={h.id}
            leading={
              <button
                type="button"
                aria-label={`View ${h.title}`}
                onClick={(e) => {
                  opener.current = e.currentTarget;
                  setViewingId(h.id);
                }}
                style={{ display: "block", padding: 0, border: "none", background: "transparent", cursor: "pointer", borderRadius: theme.radius.sm }}
              >
                <img
                  src={assets.url(h.assetId, "thumb")}
                  alt=""
                  width={48}
                  height={48}
                  style={{ display: "block", objectFit: "cover", borderRadius: theme.radius.sm, background: theme.color.bg }}
                />
              </button>
            }
            title={h.title}
            detail={pagesDetail(h)}
            style={{ padding: `${theme.space(2)}px 0` }}
            trailing={
              <Button
                size="sm"
                onClick={() => {
                  openHandout(closedStore, h);
                  props.close();
                }}
              >
                Open
              </Button>
            }
          />
        ))}
      </RowList>
      {viewed && pages ? (
        <HandoutViewer
          title={viewed.title}
          pages={pages}
          showing={showingKey(viewed)}
          details={pagesDetail(viewed) ? <span>{`${pagesDetail(viewed)}.`}</span> : undefined}
          onClose={() => setViewingId(null)}
          backClose
          opener={opener}
        />
      ) : null}
    </Section>
  );
}

/** "12 pages" under a handout of two or more pages (docs/design-v1-pdf-handouts.md 5.9). One image says nothing more, as before. */
function pagesDetail(h: Handout): string | undefined {
  const count = handoutPages(h).length;
  return count > 1 ? pageCountText(count) : undefined;
}
