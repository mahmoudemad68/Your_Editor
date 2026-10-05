"use client";

import { useState, type FormEvent } from "react";
import { credentialErrors, safeReturnTo } from "./auth-validation";
import { sessionClient, type SessionClient } from "./session-client";
import { productLabel } from "./product-label";
import { Button } from "./ui/button";

export function AuthScreen({
  mode,
  client = sessionClient,
  navigate = (path) => window.location.assign(path),
}: {
  mode: "login" | "register";
  client?: SessionClient;
  navigate?: (path: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const registering = mode === "register";
  const title = registering ? "Sign up" : "Sign in";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const validation = credentialErrors(email, password);
    setErrors(validation);
    setError(null);
    if (Object.keys(validation).length) {
      document.getElementById(validation.email ? "auth-email" : "auth-password")?.focus();
      return;
    }
    setPending(true);
    const message = await client.authenticate(mode, email, password);
    setPending(false);
    if (message !== null) {
      setError(message);
      return;
    }
    navigate(safeReturnTo(new URLSearchParams(window.location.search).get("returnTo")));
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ink px-4 py-12 text-paper">
      <section
        className="w-full max-w-md rounded-lg border border-line bg-panel p-6"
        aria-labelledby="auth-title"
      >
        <p className="text-sm text-muted">{productLabel()}</p>
        <h1 id="auth-title" className="mt-2 text-2xl font-semibold">
          {title}
        </h1>
        <p className="mt-2 text-sm text-muted">
          {registering
            ? "Create your account to start editing."
            : "Welcome back to your workspace."}
        </p>
        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => void submit(event)}
          noValidate
          aria-busy={pending}
        >
          <div>
            <label htmlFor="auth-email" className="block text-sm">
              Email
            </label>
            <input
              id="auth-email"
              name="email"
              type="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "email-error" : undefined}
              className="mt-2 w-full rounded-md border border-line bg-ink px-3 py-2"
            />
            {errors.email ? (
              <p id="email-error" role="alert" className="mt-2 text-sm text-danger">
                {errors.email}
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor="auth-password" className="block text-sm">
              Password
            </label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              required
              minLength={12}
              maxLength={200}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "password-error" : "password-help"}
              className="mt-2 w-full rounded-md border border-line bg-ink px-3 py-2"
            />
            <p id="password-help" className="mt-2 text-xs text-muted">
              12–200 characters
            </p>
            {errors.password ? (
              <p id="password-error" role="alert" className="mt-2 text-sm text-danger">
                {errors.password}
              </p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" className="w-full" disabled={pending}>
            {pending ? "Please wait…" : title}
          </Button>
        </form>
        <a
          className="mt-5 inline-block text-sm underline"
          href={registering ? "/sign-in" : "/sign-up"}
          onClick={(event) => {
            event.preventDefault();
            const target = safeReturnTo(
              new URLSearchParams(window.location.search).get("returnTo"),
            );
            navigate(
              `${registering ? "/sign-in" : "/sign-up"}?returnTo=${encodeURIComponent(target)}`,
            );
          }}
        >
          {registering ? "Already have an account? Sign in" : "New to EditAgent? Sign up"}
        </a>
      </section>
    </main>
  );
}
