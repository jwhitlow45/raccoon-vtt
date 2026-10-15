import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api.ts";
import { ErrorText } from "./Field.tsx";
import { Loading } from "./Loading.tsx";

/**
 * Cloudflare Turnstile on room creation and room import (design 10.1), and
 * on the join page once a room has seen many wrong passwords (design 10.3),
 * shown only when GET /api/config returns a site key. Without one, nothing
 * here loads and the forms are unchanged.
 *
 * The script loads from Cloudflare's own URL, which Turnstile requires
 * (a copy breaks when Cloudflare updates it), and only once a key is set, because the CSP lets
 * challenges.cloudflare.com in only then (server/http/security.ts). It
 * renders explicitly into the form, so it never scans the page.
 */

type TurnstileApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let siteKey: Promise<string | null> | undefined;

/** The public site key, or null when Turnstile is off. A failed read counts as off and is tried again next time. */
function turnstileSiteKey(): Promise<string | null> {
  siteKey ??= api.getConfig().then(
    (c) => (typeof c.turnstileSiteKey === "string" && c.turnstileSiteKey ? c.turnstileSiteKey : null),
    () => {
      siteKey = undefined;
      return null;
    },
  );
  return siteKey;
}

let script: Promise<TurnstileApi> | undefined;

function loadTurnstile(): Promise<TurnstileApi> {
  script ??= new Promise<TurnstileApi>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SCRIPT_URL;
    el.async = true;
    el.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile did not start")));
    el.onerror = () => {
      el.remove();
      reject(new Error("turnstile did not load"));
    };
    document.head.appendChild(el);
  }).catch((err: unknown) => {
    script = undefined;
    throw err;
  });
  return script;
}

export type Turnstile = {
  /** The site key is still loading. Submitting now would go without a token, so forms wait. */
  pending: boolean;
  /** Turnstile is on and the form must send `token`. */
  required: boolean;
  token: string | null;
  /** A token works once. Call after every submit, whatever the outcome, for a fresh one. */
  reset(): void;
  /** Where the form shows the check. Null when Turnstile is off. */
  widget: ReactNode;
};

export function useTurnstile(): Turnstile {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  const [token, setToken] = useState<string | null>(null);
  // A new widget for each round, which gives a fresh token.
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    void turnstileSiteKey().then((k) => live && setKey(k));
    return () => {
      live = false;
    };
  }, []);
  return {
    pending: key === undefined,
    required: typeof key === "string",
    token,
    reset: () => {
      setToken(null);
      setRound((r) => r + 1);
    },
    widget: typeof key === "string" ? <TurnstileWidget key={round} siteKey={key} onToken={setToken} /> : null,
  };
}

function TurnstileWidget(props: { siteKey: string; onToken(token: string | null): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  // Cloudflare's script is a separate download, and the form's button waits
  // on it, so the empty box says what it is waiting for.
  const [ready, setReady] = useState(false);
  const { siteKey, onToken } = props;
  useEffect(() => {
    let live = true;
    let widgetId: string | undefined;
    loadTurnstile().then(
      (turnstile) => {
        if (!live || !ref.current) return;
        widgetId = turnstile.render(ref.current, {
          sitekey: siteKey,
          theme: "dark",
          size: "flexible",
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
        setReady(true);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
      if (widgetId !== undefined) window.turnstile?.remove(widgetId);
    };
  }, [siteKey, onToken]);
  return (
    <div style={{ position: "relative" }}>
      {/* The widget's own height, so the form does not jump when it appears. */}
      <div ref={ref} style={{ minHeight: 65 }} />
      {ready || failed ? null : <Loading text="Loading the human check…" style={{ position: "absolute", inset: 0 }} />}
      {failed ? <ErrorText>The human check could not load. Check your connection, then reload the page.</ErrorText> : null}
    </div>
  );
}
