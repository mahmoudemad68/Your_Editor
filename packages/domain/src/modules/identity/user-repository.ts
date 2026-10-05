import { DomainError } from "../../kernel/error.js";
import { type UserId } from "../../kernel/id.js";
import { type RefreshSession } from "./refresh-session.js";
import { type User } from "./user.js";

/** Two registrations stored the same email. The HTTP layer maps this to 409. */
export class AccountEmailConflict extends DomainError {
  constructor() {
    super("An account with that email already exists.");
    this.name = "AccountEmailConflict";
  }
}

export type FailedAttemptResult = "recorded" | "locked" | "missing";
export type ClearAttemptsResult = "cleared" | "locked" | "missing";

/**
 * The presented session was active and this call inserted its only replacement.
 * `reused` means the session was already inactive, so every active session for
 * that account was revoked. `rejected` means the token was unknown or the
 * secret did not match; no session was changed.
 */
export type RefreshRotation =
  | {
      readonly outcome: "consumed";
      readonly userId: UserId;
      readonly replacement: RefreshSession;
    }
  | { readonly outcome: "reused"; readonly userId: UserId }
  | { readonly outcome: "rejected" };

export type RotationDecision =
  | { readonly action: "reject" }
  | { readonly action: "reuse" }
  | { readonly action: "replace"; readonly replacement: RefreshSession };

/** Persistence port for accounts. Email lookup enforces uniqueness. */
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<void>;
  /**
   * Records one eligible wrong password. The count and lock are a single
   * conditional transition. A locked account is not incremented.
   */
  recordFailedAttempt(
    id: UserId,
    now: bigint,
    limit: number,
    lockForMs: bigint,
  ): Promise<FailedAttemptResult>;
  /**
   * Clears the failure count only while the account is not locked.
   * An active lock is left unchanged.
   */
  clearFailedAttempts(id: UserId, now: bigint): Promise<ClearAttemptsResult>;
}

export interface RefreshSessionRepository {
  findById(id: string): Promise<RefreshSession | null>;
  save(session: RefreshSession): Promise<void>;
  revokeAllForUser(userId: UserId, revokedAt: bigint): Promise<void>;
  /**
   * Revokes the presented session and every replacement rotated from it.
   * The account row is locked before the session rows, matching rotation.
   */
  endSession(
    sessionId: string,
    now: bigint,
    presentedSecretHash: string,
  ): Promise<"ended" | "rejected">;
  /**
   * Consumes an active refresh session at most once and inserts its replacement
   * in the same transaction. `decide` and `beforeCommit` run while that account
   * is locked. They must not take another database lock. A throw from either
   * rolls the consumption back.
   */
  rotate(
    sessionId: string,
    now: bigint,
    decide: (current: RefreshSession | null) => RotationDecision | Promise<RotationDecision>,
    beforeCommit?: (replacement: RefreshSession) => Promise<void>,
  ): Promise<RefreshRotation>;
}
