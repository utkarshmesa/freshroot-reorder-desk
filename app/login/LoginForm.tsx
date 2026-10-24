"use client";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { browserClient } from "@/lib/db/browser";
import { sendSignInLink } from "./actions";

export function LoginForm({ linkError }: { linkError: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [linkMessage, requestLink, linkPending] = useActionState(sendSignInLink, null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { error: err } = await browserClient().auth.signInWithPassword({ email: String(f.get("email")), password: String(f.get("password")) });
    setBusy(false);
    if (err) setError("Email or password is wrong.");
    else {
      router.replace("/");
      router.refresh();
    }
  }

  return (
    <main style={{ maxWidth: 380 }}>
      <h1>Freshroots Reorder Desk</h1>
      <form className="card" onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && <p className="err">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {linkError && <p className="err">That sign-in link has expired or was already used. Ask for a new one below.</p>}
      <form className="card" action={requestLink} style={{ display: "grid", gap: 12 }}>
        <label>
          Or get a sign-in link by email
          <input name="email" type="email" autoComplete="username" required aria-label="Email for a sign-in link" />
        </label>
        {linkMessage && <p className="muted">{linkMessage}</p>}
        <button disabled={linkPending}>{linkPending ? "Sending…" : "Email me a sign-in link"}</button>
      </form>
      <p className="muted">Ask the IT admin if you don&apos;t have an account.</p>
    </main>
  );
}
