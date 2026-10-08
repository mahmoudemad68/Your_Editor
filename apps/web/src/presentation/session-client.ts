import type { components } from "../generated/schema";

export type SessionUser = Readonly<components["schemas"]["SessionUserBody"]>;
export type SessionState =
  | { readonly status: "checking" }
  | { readonly status: "authenticated"; readonly user: SessionUser }
  | { readonly status: "unauthenticated" }
  | { readonly status: "error"; readonly message: string };

const CHECKING: SessionState = { status: "checking" };
const UNAUTHENTICATED: SessionState = { status: "unauthenticated" };

export function readBrowserCsrf(): string | null {
  if (typeof document === "undefined") return null;
  const part = document.cookie
    .split(";")
    .find((cookie) => cookie.trim().startsWith("editagent_csrf="));
  try {
    return part ? decodeURIComponent(part.trim().slice("editagent_csrf=".length)) : null;
  } catch {
    return null;
  }
}

async function browserRefreshLock<T>(work: () => Promise<T>): Promise<T> {
  // Serialize across tabs too. Recheck /auth/me inside the lock before rotation.
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request("editagent-session", work);
  }
  return work();
}

/** Contains only authenticated identity, never access/refresh tokens. */
export class SessionClient {
  private state: SessionState = CHECKING;
  private listeners = new Set<() => void>();
  private bootstrapWork: Promise<void> | null = null;
  private refreshWork: Promise<boolean> | null = null;
  private generation = 0;
  private identityEpoch = 0;

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly readCsrf: () => string | null = readBrowserCsrf,
    private readonly refreshLock: <T>(work: () => Promise<T>) => Promise<T> = browserRefreshLock,
  ) {}

  getSnapshot = (): SessionState => this.state;
  getServerSnapshot = (): SessionState => CHECKING;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(state: SessionState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }

  private raw(url: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has("x-request-id"))
      headers.set("x-request-id", `req_${crypto.randomUUID().replace(/-/g, "")}`);
    if (!["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase())) {
      const csrf = this.readCsrf();
      if (csrf !== null) headers.set("x-editagent-csrf", csrf);
    }
    return this.fetchImpl(url, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    });
  }

  bootstrap(): Promise<void> {
    if (this.bootstrapWork) return this.bootstrapWork;
    if (this.state.status === "authenticated" || this.state.status === "unauthenticated")
      return Promise.resolve();
    this.publish(CHECKING);
    const identityEpoch = this.identityEpoch;
    this.bootstrapWork = (async () => {
      try {
        const response = await this.authenticatedFetch("/auth/me");
        if (response.ok) {
          const user = await readUser(response);
          if (identityEpoch === this.identityEpoch) {
            this.publish({ status: "authenticated", user });
          }
        } else if (
          identityEpoch === this.identityEpoch &&
          response.status !== 401 &&
          this.state.status !== "unauthenticated"
        ) {
          this.publish({
            status: "error",
            message: "Your session could not be checked. Try again.",
          });
        }
      } catch {
        if (identityEpoch === this.identityEpoch && this.state.status !== "unauthenticated")
          this.publish({
            status: "error",
            message: "Your session could not be checked. Try again.",
          });
      } finally {
        this.bootstrapWork = null;
      }
    })();
    return this.bootstrapWork;
  }

  private refresh(): Promise<boolean> {
    if (this.refreshWork) return this.refreshWork;
    if (this.state.status === "unauthenticated") return Promise.resolve(false);
    this.refreshWork = this.refreshLock(async () => {
      const current = await this.raw("/auth/me");
      let response = current;
      if (current.status === 401) {
        response = await this.raw("/auth/refresh", { method: "POST" });
      }
      if (response.ok) {
        const user = await readUser(response);
        this.generation++;
        this.publish({ status: "authenticated", user });
        return true;
      }
      if (response.status === 401 || response.status === 403) {
        this.generation++;
        this.identityEpoch++;
        this.publish(UNAUTHENTICATED);
        return false;
      }
      throw new Error("Your session could not be refreshed. Try again.");
    }).finally(() => {
      this.refreshWork = null;
    });
    return this.refreshWork;
  }

  async authenticatedFetch(url: string, init?: RequestInit): Promise<Response> {
    if (url !== "/auth/me" && !url.startsWith("/api/"))
      throw new Error("Expected an internal application request.");
    const generation = this.generation;
    const response = await this.raw(url, init);
    if (!(await unauthorized(response))) return response;
    const recovered =
      this.generation !== generation ? this.state.status === "authenticated" : await this.refresh();
    if (!recovered) return response;
    // Exactly one retry; reconstruct headers to use the rotated CSRF cookie.
    const retried = await this.raw(url, init);
    if (await unauthorized(retried)) {
      this.generation++;
      this.identityEpoch++;
      this.publish(UNAUTHENTICATED);
    }
    return retried;
  }

  async authenticate(
    action: "login" | "register",
    email: string,
    password: string,
  ): Promise<string | null> {
    try {
      return await this.refreshLock(async () => {
        const response = await this.raw(`/auth/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        if (!response.ok) return authMessage(response.status, action);
        const user = await readUser(response);
        this.generation++;
        this.identityEpoch++;
        this.publish({ status: "authenticated", user });
        return null;
      });
    } catch {
      return "The authentication service could not be reached. Try again.";
    }
  }

  async logout(): Promise<string | null> {
    try {
      if (this.refreshWork) await this.refreshWork;
      return await this.refreshLock(async () => {
        const response = await this.raw("/auth/logout", { method: "POST" });
        if (!response.ok) return "Sign out could not be completed. Try again.";
        this.generation++;
        this.identityEpoch++;
        this.publish(UNAUTHENTICATED);
        return null;
      });
    } catch {
      return "Sign out could not be completed. Try again.";
    }
  }
}

async function unauthorized(response: Response): Promise<boolean> {
  if (response.status === 401) return true;
  if (!response.ok || response.headers.get("content-type")?.startsWith("text/event-stream"))
    return false;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return (
    typeof body === "object" &&
    body !== null &&
    "ok" in body &&
    body.ok === false &&
    "status" in body &&
    body.status === 401
  );
}

async function readUser(response: Response): Promise<SessionUser> {
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("id" in body) ||
    !("email" in body) ||
    typeof body.id !== "string" ||
    typeof body.email !== "string"
  )
    throw new Error("Invalid session response.");
  return { id: body.id, email: body.email };
}

function authMessage(status: number, action: "login" | "register"): string {
  if (status === 429) return "Too many attempts. Please wait a minute before trying again.";
  if (status === 409 && action === "register")
    return "An account with that email already exists. Sign in instead.";
  if (status === 403)
    return "This authentication request was refused. Reload the page and try again.";
  if (status === 401 || (status === 400 && action === "login"))
    return "Email or password is incorrect.";
  if (status === 400) return "Check your email and use a password between 12 and 200 characters.";
  return "The authentication service is unavailable. Try again.";
}

export const sessionClient = new SessionClient();
