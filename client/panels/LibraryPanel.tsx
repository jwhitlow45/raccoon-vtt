import { useMemo } from "react";
import type { Handout } from "#shared/model.ts";
import { Button } from "../components/Button.tsx";
import { Section } from "../components/Panel.tsx";
import { Row, RowList } from "../components/Row.tsx";
import { closedSlot, openHandout } from "../features/handouts/closed.ts";
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
  return (
    <div style={{ display: "grid", gap: theme.space(3) }}>
      {role === "player" ? <ShowingHandouts close={props.close} /> : null}
      <LibraryGrid
        roomId={roomId}
        empty="No images yet. Add one with the image picker of a token or a character."
        hint="Images are added with the image picker of a token or a character."
      />
    </div>
  );
}

function ShowingHandouts(props: { close(): void }) {
  const handouts = useRoomView((s) => s.view?.handouts);
  const assets = useAssets();
  const closedStore = useScoped(closedSlot);
  const showing = useMemo(
    () => Object.values(handouts ?? {}).filter((h): h is Handout => h !== undefined).sort((a, b) => (a.shownAt < b.shownAt ? 1 : -1)),
    [handouts],
  );
  if (showing.length === 0) return null;
  return (
    <Section label="Handouts from the DM" divider={false} style={{ borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
      <RowList>
        {showing.map((h) => (
          <Row
            key={h.id}
            leading={
              <img
                src={assets.url(h.assetId, "thumb")}
                alt=""
                width={48}
                height={48}
                style={{ display: "block", objectFit: "cover", borderRadius: theme.radius.sm, background: theme.color.bg }}
              />
            }
            title={h.title}
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
    </Section>
  );
}
