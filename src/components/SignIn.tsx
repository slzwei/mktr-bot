import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Bot, LoaderCircle } from "lucide-react";
import { api, ApiError, type Operator } from "../lib/api";

export function SessionGate({ children }: { children: (operator: Operator, signOut: () => Promise<void>) => ReactNode }) {
  const [operator, setOperator] = useState<Operator>();
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const expire = () => { setOperator(undefined); setError("Your session ended. Sign in to continue."); };
    window.addEventListener("mktr:sign-in-required", expire);
    api.session().then(({ user }) => setOperator(user)).catch((cause) => {
      if (!(cause instanceof ApiError && cause.status === 401)) setError("Could not reach Voice Control. Try again shortly.");
    }).finally(() => setLoading(false));
    return () => window.removeEventListener("mktr:sign-in-required", expire);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const { user } = await api.login(email, password);
      setOperator(user);
      setPassword("");
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Could not reach Voice Control. Try again shortly.");
    } finally { setSubmitting(false); }
  }
  if (loading) return <main className="loading-screen"><LoaderCircle className="spin" size={22} /><strong>Loading voice control</strong></main>;
  if (operator) return <>{children(operator, async () => {
    try { await api.logout(); setOperator(undefined); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign out."); }
  })}{error && <p role="alert" className="toast toast--error">{error}</p>}</>;
  return <main className="sign-in-screen"><form className="sign-in-card" onSubmit={submit}>
    <span className="brand-mark"><Bot size={24} /></span>
    <h1>Sign in to Voice Control</h1>
    <p>Use your MKTR operator account.</p>
    <label>Email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
    <label>Password<input type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}</button>
  </form></main>;
}
