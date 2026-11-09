import { FormEvent, useState } from "react";
import { ArrowRight, Box } from "lucide-react";
import { api } from "../api";

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.login(username, password);
      onLogin();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-page">
    <form className="login-card" onSubmit={submit}>
      <div className="brand-mark"><Box size={22} strokeWidth={1.7} /></div>
      <div>
        <h1>Welcome to Pi-Ark</h1>
        <p>Sign in to continue to your workspaces.</p>
      </div>
      <label>Username<input autoComplete="username" autoFocus value={username} onChange={(event) => setUsername(event.target.value)} /></label>
      <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <div className="form-error">{error}</div>}
      <button className="primary-button" disabled={busy || !username || !password}>{busy ? "Signing in…" : "Continue"}<ArrowRight size={16} /></button>
    </form>
  </main>;
}
