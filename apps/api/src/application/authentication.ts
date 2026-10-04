import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createUuidV7,
  normalizeEmail,
  RefreshSession,
  type RefreshSessionRepository,
  User,
  userId,
  type UserId,
  type UserRepository,
} from "@editagent/domain";
import { type Clock } from "./clock.js";
import { LoginRateLimit } from "./login-rate-limit.js";
import { type PasswordHasher } from "./password-hasher.js";
import { type SessionTokens } from "./session-tokens.js";

const ACCESS_TTL_MS = 15n * 60n * 1000n;
const REFRESH_TTL_MS = 14n * 24n * 60n * 60n * 1000n;
const LOCK_AFTER = 5;
const LOCK_FOR_MS = 15n * 60n * 1000n;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 200;

export const ACCESS_TTL_SECONDS = Number(ACCESS_TTL_MS / 1000n);
export const REFRESH_TTL_SECONDS = Number(REFRESH_TTL_MS / 1000n);

export class EmailAlreadyRegisteredError extends Error {
  constructor() {
    super("An account with that email already exists.");
    this.name = "EmailAlreadyRegisteredError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Email or password is incorrect.");
    this.name = "InvalidCredentialsError";
  }
}

export class AuthRateLimitedError extends Error {
  constructor() {
    super("Too many sign-in attempts. Try again later.");
    this.name = "AuthRateLimitedError";
  }
}

export interface AuthenticatedSession {
  readonly userId: UserId;
  readonly email: string;
  readonly accessToken: string;
  readonly accessExpiresAt: bigint;
  readonly refreshToken: string;
  readonly refreshExpiresAt: bigint;
  readonly csrfToken: string;
}

export class RegisterUser {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: RefreshSessionRepository,
    private readonly passwords: PasswordHasher,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
    private readonly rateLimit: LoginRateLimit,
    private readonly newId: () => string = () => createUuidV7(Date.now(), randomBytes(10)),
  ) {}

  async execute(email: string, password: string, clientKey: string): Promise<AuthenticatedSession> {
    this.guardRate(clientKey);
    if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      throw new InvalidCredentialsError();
    }
    const normalized = normalizeEmail(email);
    if ((await this.users.findByEmail(normalized)) !== null) {
      throw new EmailAlreadyRegisteredError();
    }
    const now = this.clock.now();
    const user = User.create(
      userId(this.newId()),
      normalized,
      await this.passwords.hash(password),
      now,
    );
    await this.users.save(user);
    return openSession(this.sessions, this.tokens, user, now, null);
  }

  private guardRate(clientKey: string): void {
    if (!this.rateLimit.allow(clientKey, Number(this.clock.now()))) {
      throw new AuthRateLimitedError();
    }
  }
}

export class LoginUser {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: RefreshSessionRepository,
    private readonly passwords: PasswordHasher,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
    private readonly rateLimit: LoginRateLimit,
  ) {}

  async execute(email: string, password: string, clientKey: string): Promise<AuthenticatedSession> {
    if (!this.rateLimit.allow(clientKey, Number(this.clock.now()))) {
      throw new AuthRateLimitedError();
    }
    let normalized: string;
    try {
      normalized = normalizeEmail(email);
    } catch {
      throw new InvalidCredentialsError();
    }
    const user = await this.users.findByEmail(normalized);
    const now = this.clock.now();
    if (user === null) {
      await this.passwords.burn(password);
      throw new InvalidCredentialsError();
    }
    if (user.isLocked(now)) {
      await this.passwords.verify(user.passwordHash, password);
      throw new InvalidCredentialsError();
    }
    const matches = await this.passwords.verify(user.passwordHash, password);
    if (!matches) {
      await this.users.recordFailedAttempt(user.id, now, LOCK_AFTER, LOCK_FOR_MS);
      throw new InvalidCredentialsError();
    }
    const cleared = await this.users.clearFailedAttempts(user.id, now);
    if (cleared !== "cleared") {
      throw new InvalidCredentialsError();
    }
    return openSession(this.sessions, this.tokens, user, now, null);
  }
}

export class RefreshAccess {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: RefreshSessionRepository,
    private readonly tokens: SessionTokens,
    private readonly clock: Clock,
  ) {}

  async execute(refreshToken: string): Promise<AuthenticatedSession> {
    const now = this.clock.now();
    const parsed = parseRefreshToken(refreshToken);
    const secret = randomBytes(32).toString("base64url");
    let accessToken = "";
    let accessExpiresAt = now;
    const rotation = await this.sessions.rotate(
      parsed.id,
      now,
      (current) => {
        if (current === null || !secretMatches(current.secretHash, parsed.secret)) {
          return { action: "reject" };
        }
        if (!current.isActive(now)) {
          return { action: "reuse" };
        }
        return {
          action: "replace",
          replacement: RefreshSession.issue(
            createUuidV7(Number(now), randomBytes(10)),
            current.userId,
            hashSecret(secret),
            now,
            now + REFRESH_TTL_MS,
            current.id,
          ),
        };
      },
      async (replacement) => {
        const access = await this.tokens.issueAccess(replacement.userId, now);
        accessToken = access.token;
        accessExpiresAt = access.expiresAt;
      },
    );
    if (rotation.outcome !== "consumed") {
      throw new InvalidCredentialsError();
    }
    const user = await this.users.findById(rotation.userId);
    if (user === null) {
      throw new InvalidCredentialsError();
    }
    return {
      userId: user.id,
      email: user.email,
      accessToken,
      accessExpiresAt,
      refreshToken: `${rotation.replacement.id}.${secret}`,
      refreshExpiresAt: rotation.replacement.expiresAt,
      csrfToken: randomBytes(32).toString("base64url"),
    };
  }
}

export class LogoutUser {
  constructor(
    private readonly sessions: RefreshSessionRepository,
    private readonly clock: Clock,
  ) {}

  async execute(refreshToken: string | undefined): Promise<void> {
    if (refreshToken === undefined || refreshToken.length === 0) {
      return;
    }
    let parsed: { id: string; secret: string };
    try {
      parsed = parseRefreshToken(refreshToken);
    } catch {
      return;
    }
    const current = await this.sessions.findById(parsed.id);
    if (current === null || !secretMatches(current.secretHash, parsed.secret)) {
      return;
    }
    await this.sessions.save(current.revoke(this.clock.now()));
  }
}

async function openSession(
  sessions: RefreshSessionRepository,
  tokens: SessionTokens,
  user: User,
  now: bigint,
  rotatedFromId: string | null,
): Promise<AuthenticatedSession> {
  const secret = randomBytes(32).toString("base64url");
  const session = RefreshSession.issue(
    createUuidV7(Number(now), randomBytes(10)),
    user.id,
    hashSecret(secret),
    now,
    now + REFRESH_TTL_MS,
    rotatedFromId,
  );
  await sessions.save(session);
  const access = await tokens.issueAccess(user.id, now);
  return {
    userId: user.id,
    email: user.email,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: `${session.id}.${secret}`,
    refreshExpiresAt: session.expiresAt,
    csrfToken: randomBytes(32).toString("base64url"),
  };
}

function parseRefreshToken(token: string): { id: string; secret: string } {
  const split = token.indexOf(".");
  if (split <= 0 || split === token.length - 1) {
    throw new InvalidCredentialsError();
  }
  return { id: token.slice(0, split), secret: token.slice(split + 1) };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secretMatches(storedHash: string, secret: string): boolean {
  const actual = Buffer.from(hashSecret(secret));
  const expected = Buffer.from(storedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
