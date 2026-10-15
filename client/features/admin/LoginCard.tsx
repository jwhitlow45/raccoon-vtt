import { useState, type FormEvent } from "react";
import { Button } from "../../components/Button.tsx";
import { Card, ErrorText, Field } from "../../components/Field.tsx";
import { Notice } from "../../components/Notice.tsx";
import { useTurnstile } from "../../components/Turnstile.tsx";
import { theme } from "../../lib/theme.ts";
import { adminApi } from "./api.ts";
import { loginErrorText } from "./format.ts";

/**
 * The admin password, and the Turnstile check whenever the server has
 * Turnstile, not only after failures (docs/design-v1-dm-tools.md 3.18).
 */
export function LoginCard(props: { notice?: string | null; onSignedIn(): void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const turnstile = useTurnstile();
  const waiting = turnstile.pending || (turnstile.required && !turnstile.token);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || waiting || password === "") return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.login(password, turnstile.token ?? undefined);
      setPassword("");
      props.onSignedIn();
    } catch (err) {
      setError(loginErrorText(err));
    } finally {
      setBusy(false);
      // A token works once, so every attempt gets a fresh check.
      if (turnstile.required) turnstile.reset();
    }
  }

  return (
    <Card title="Sign in">
      {props.notice ? <Notice tone="warning">{props.notice}</Notice> : null}
      <form onSubmit={submit} style={{ display: "grid", gap: theme.space(3) }}>
        <Field
          label="Admin password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />
        {turnstile.widget}
        <ErrorText>{error}</ErrorText>
        <Button type="submit" variant="primary" block busy={busy} disabled={!busy && (waiting || password === "")}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </Card>
  );
}
