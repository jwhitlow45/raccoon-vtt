import { useState, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { Card } from "../../components/Field.tsx";
import { navigate } from "../../lib/navigation.ts";
import { theme } from "../../lib/theme.ts";
import { displayPath, rememberedDisplayRoom } from "./remember.ts";

/**
 * Home's way to a table display (docs/design-v1-dm-tools.md 3.1): a TV's
 * browser opens `/display` here and types the DM's code. A device already
 * paired goes back to its room, and Leave there brings it back here.
 *
 * `foot` is Home's closing tip, kept inside the last card so it does not
 * float under the cards on its own.
 */
export function TableDisplayCard(props: { foot?: ReactNode }) {
  const [roomId] = useState(rememberedDisplayRoom);
  return (
    <Card title="Table display">
      <p style={{ margin: 0, color: theme.color.textMuted, fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
        Show the map on a TV for everyone at the table, as the players see it. The DM gives this screen a code.
      </p>
      {roomId ? (
        <Button variant="primary" block onClick={() => navigate(displayPath(roomId))}>
          Open the table display
        </Button>
      ) : null}
      <Button block onClick={() => navigate("/display")}>
        Set up a table display
      </Button>
      {props.foot}
    </Card>
  );
}
