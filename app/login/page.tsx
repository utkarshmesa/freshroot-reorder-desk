"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { browserClient } from "@/lib/db/browser";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <p className="muted">Ask the IT admin if you don&apos;t have an account.</p>
    </main>
  );
}
