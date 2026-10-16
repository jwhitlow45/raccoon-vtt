import { useEffect, useState } from "react";
import { BANNER_DELAY_MS, connectionLabel, dotColor, type ConnectionState } from "../lib/connection.ts";
import { theme } from "../lib/theme.ts";
import { Notice } from "./Notice.tsx";

const DOT: Record<ReturnType<typeof dotColor>, string> = {
  green: theme.color.success,
  amber: theme.color.warning,
  red: theme.color.danger,
};

/** The small dot in the top bar (design section 7.5). The label is for screen readers and a tap-and-hold tooltip. */
export function ConnectionDot(props: { state: ConnectionState }) {
  const label = connectionLabel(props.state);
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        flex: "none",
        borderRadius: theme.radius.round,
        background: DOT[dotColor(props.state)],
        boxShadow: theme.shadow.rim,
      }}
    />
  );
}

/**
 * Appears only after 3 s without a connection, so a phone waking up or a
 * blip on the network never flashes it, and disappears the moment the
 * connection (with its snapshot) is back. The 3 s count from leaving `open`,
 * not from each change between the other states.
 */
export function ReconnectBanner(props: { state: ConnectionState }) {
  const due = useReconnectDue(props.state);
  return due ? <ReconnectNotice state={props.state} /> : null;
}

/**
 * Whether the banner is due: 3 s after leaving `open`, until it is back.
 * Apart from the notice, so a room that moves the notice into a modal sheet
 * keeps the count where it is (pages/modalSlot.tsx).
 */
export function useReconnectDue(state: ConnectionState): boolean {
  const connected = state === "open";
  const [due, setDue] = useState(false);
  useEffect(() => {
    setDue(false);
    if (connected) return;
    const timer = setTimeout(() => setDue(true), BANNER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  return !connected && due;
}

/** The banner itself, for a state that is not `open`. */
export function ReconnectNotice(props: { state: ConnectionState }) {
  const { state } = props;
  const offline = state === "offline";
  return (
    <Notice role="status" tone={offline ? "danger" : "warning"} float leading={<ConnectionDot state={state} />}>
      {offline
        ? "You are offline. Your changes are kept and will be sent when you reconnect."
        : state === "connecting"
          ? "Connecting to the room… This can take a moment on a slow connection."
          : "Reconnecting… Your changes are kept and will be sent when the connection is back."}
    </Notice>
  );
}
