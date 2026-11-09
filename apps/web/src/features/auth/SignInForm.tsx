import { useState } from "react";

export function SignInForm({ onSubmit }: { onSubmit: (input: { email: string; password: string }) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  return <form className="border-border bg-surface mx-auto grid max-w-md gap-4 rounded-lg border p-6" onSubmit={async (event) => {
    event.preventDefault();
    setError(undefined);
    setLoading(true);
    try { await onSubmit({ email, password }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível entrar."); } finally { setLoading(false); }
  }}>
    <div><h1 className="text-lg font-semibold">Entrar no PDV</h1><p className="text-muted-foreground mt-1 text-sm">Use o usuário autorizado para a organização.</p></div>
    <label className="grid gap-1 text-sm">E-mail<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="border-border rounded-md border px-3 py-2" /></label>
    <label className="grid gap-1 text-sm">Senha<input required type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} className="border-border rounded-md border px-3 py-2" /></label>
    <button className="bg-foreground text-background rounded-md px-3 py-2 text-sm font-medium disabled:opacity-60" disabled={loading} type="submit">{loading ? "Entrando..." : "Entrar"}</button>
    {error ? <p className="text-sm text-muted-foreground" role="alert">{error}</p> : null}
  </form>;
}
