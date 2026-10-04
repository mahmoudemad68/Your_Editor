/**
 * Identity aggregate. The password is stored only as an argon2id hash.
 * The Admin operator role does not create a Project membership.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type UserId, userId } from "../../kernel/id.js";

/** Operator role. It is not Owner, Editor, or Viewer. */
export type OperatorRole = "admin";

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

export interface UserSnapshot {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly operatorRole: string | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: bigint | string | null;
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
}

export class User {
  readonly id: UserId;
  readonly email: string;
  readonly passwordHash: string;
  readonly operatorRole: OperatorRole | null;
  readonly failedLoginCount: number;
  readonly lockedUntil: Instant | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  constructor(
    id: UserId | string,
    email: string,
    passwordHash: string,
    operatorRoleValue: OperatorRole | string | null,
    createdAt: Instant | string | bigint,
    updatedAt?: Instant | string | bigint,
    failedLoginCount = 0,
    lockedUntil: Instant | string | bigint | null = null,
  ) {
    const created = instant(createdAt);
    this.id = userId(String(id));
    this.email = normalizeEmail(email);
    this.passwordHash = requireArgon2idHash(passwordHash);
    this.operatorRole = operatorRole(operatorRoleValue);
    this.createdAt = created;
    this.updatedAt = updatedAt == null ? created : instant(updatedAt);
    if (!Number.isInteger(failedLoginCount) || failedLoginCount < 0) {
      throw new DomainError("Failed login count must be a non-negative integer.");
    }
    this.failedLoginCount = failedLoginCount;
    this.lockedUntil = lockedUntil == null ? null : instant(lockedUntil);
    requireAuditOrder(this.createdAt, this.updatedAt);
    Object.freeze(this);
  }

  static create(
    id: UserId,
    email: string,
    passwordHash: string,
    createdAt: Instant,
    operatorRoleValue: OperatorRole | null = null,
  ): User {
    return new User(id, email, passwordHash, operatorRoleValue, createdAt, createdAt, 0, null);
  }

  /** Rebuild a persisted User. Does not replay registration. */
  static restore(snapshot: UserSnapshot): User {
    return new User(
      snapshot.id,
      snapshot.email,
      snapshot.passwordHash,
      snapshot.operatorRole,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.failedLoginCount,
      snapshot.lockedUntil,
    );
  }

  toSnapshot(): UserSnapshot {
    return {
      id: this.id,
      email: this.email,
      passwordHash: this.passwordHash,
      operatorRole: this.operatorRole,
      failedLoginCount: this.failedLoginCount,
      lockedUntil: this.lockedUntil,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  isAdmin(): boolean {
    return this.operatorRole === "admin";
  }

  isLocked(now: Instant): boolean {
    return this.lockedUntil !== null && this.lockedUntil > now;
  }

  recordFailedLogin(now: Instant, limit: number, lockForMs: bigint): User {
    const count = this.failedLoginCount + 1;
    const lockedUntil = count >= limit ? instant(now + lockForMs) : this.lockedUntil;
    return new User(
      this.id,
      this.email,
      this.passwordHash,
      this.operatorRole,
      this.createdAt,
      now,
      count,
      lockedUntil,
    );
  }

  clearFailedLogins(now: Instant): User {
    return new User(
      this.id,
      this.email,
      this.passwordHash,
      this.operatorRole,
      this.createdAt,
      now,
      0,
      null,
    );
  }
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL.test(email)) {
    throw new DomainError("Email is not valid.");
  }
  return email;
}

export function requireArgon2idHash(value: string): string {
  if (!value.startsWith("$argon2id$")) {
    throw new DomainError("Password hash must be an argon2id encoding.");
  }
  return value;
}

export function operatorRole(value: string | null): OperatorRole | null {
  if (value === null) {
    return null;
  }
  if (value === "admin") {
    return "admin";
  }
  throw new DomainError(
    "Operator role must be admin or absent. Owner, Editor, and Viewer are Project membership roles.",
  );
}
