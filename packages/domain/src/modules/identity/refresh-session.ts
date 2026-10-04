/**
 * Refresh session. The raw token is never stored. rotatedFromId links a
 * replacement to the session it consumed.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type UserId, userId, uuidV7 } from "../../kernel/id.js";

export interface RefreshSessionSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly secretHash: string;
  readonly rotatedFromId: string | null;
  readonly expiresAt: bigint | string;
  readonly revokedAt: bigint | string | null;
  readonly createdAt: bigint | string;
}

export class RefreshSession {
  readonly id: string;
  readonly userId: UserId;
  readonly secretHash: string;
  readonly rotatedFromId: string | null;
  readonly expiresAt: Instant;
  readonly revokedAt: Instant | null;
  readonly createdAt: Instant;

  constructor(
    id: string,
    owner: UserId | string,
    secretHash: string,
    rotatedFromId: string | null,
    expiresAt: Instant | string | bigint,
    revokedAt: Instant | string | bigint | null,
    createdAt: Instant | string | bigint,
  ) {
    this.id = uuidV7(id);
    this.userId = userId(String(owner));
    if (secretHash.length < 32) {
      throw new DomainError("Refresh secret hash is too short.");
    }
    this.secretHash = secretHash;
    this.rotatedFromId = rotatedFromId === null ? null : uuidV7(rotatedFromId);
    this.expiresAt = instant(expiresAt);
    this.revokedAt = revokedAt === null ? null : instant(revokedAt);
    this.createdAt = instant(createdAt);
    requireAuditOrder(this.createdAt, this.expiresAt);
    if (this.revokedAt !== null) {
      requireAuditOrder(this.createdAt, this.revokedAt);
    }
    Object.freeze(this);
  }

  static issue(
    id: string,
    owner: UserId,
    secretHash: string,
    createdAt: Instant,
    expiresAt: Instant,
    rotatedFromId: string | null = null,
  ): RefreshSession {
    return new RefreshSession(id, owner, secretHash, rotatedFromId, expiresAt, null, createdAt);
  }

  static restore(snapshot: RefreshSessionSnapshot): RefreshSession {
    return new RefreshSession(
      snapshot.id,
      snapshot.userId,
      snapshot.secretHash,
      snapshot.rotatedFromId,
      snapshot.expiresAt,
      snapshot.revokedAt,
      snapshot.createdAt,
    );
  }

  isActive(now: Instant): boolean {
    return this.revokedAt === null && this.expiresAt > now;
  }

  revoke(now: Instant): RefreshSession {
    if (this.revokedAt !== null) {
      return this;
    }
    return new RefreshSession(
      this.id,
      this.userId,
      this.secretHash,
      this.rotatedFromId,
      this.expiresAt,
      now,
      this.createdAt,
    );
  }

  toSnapshot(): RefreshSessionSnapshot {
    return {
      id: this.id,
      userId: this.userId,
      secretHash: this.secretHash,
      rotatedFromId: this.rotatedFromId,
      expiresAt: this.expiresAt,
      revokedAt: this.revokedAt,
      createdAt: this.createdAt,
    };
  }
}
