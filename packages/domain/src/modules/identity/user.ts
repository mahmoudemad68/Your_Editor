/**
 * Identity aggregate. Password hashes and refresh sessions are planned in the ER
 * for US-118. They are not fields on this class yet.
 * The Admin operator role does not create a Project membership.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type UserId, userId } from "../../kernel/id.js";

/** Operator role. It is not Owner, Editor, or Viewer. */
export type OperatorRole = "admin";

export interface UserSnapshot {
  readonly id: string;
  readonly operatorRole: string | null;
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
}

export class User {
  readonly id: UserId;
  readonly operatorRole: OperatorRole | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  constructor(
    id: UserId | string,
    operatorRoleValue: OperatorRole | string | null,
    createdAt: Instant | string | bigint,
    updatedAt?: Instant | string | bigint,
  ) {
    const created = instant(createdAt);
    this.id = userId(String(id));
    this.operatorRole = operatorRole(operatorRoleValue);
    this.createdAt = created;
    this.updatedAt = updatedAt == null ? created : instant(updatedAt);
    Object.freeze(this);
  }

  static create(
    id: UserId,
    createdAt: Instant,
    operatorRoleValue: OperatorRole | null = null,
  ): User {
    return new User(id, operatorRoleValue, createdAt, createdAt);
  }

  /** Rebuild a persisted User. Does not replay registration. */
  static restore(snapshot: UserSnapshot): User {
    return new User(snapshot.id, snapshot.operatorRole, snapshot.createdAt, snapshot.updatedAt);
  }

  toSnapshot(): UserSnapshot {
    return {
      id: this.id,
      operatorRole: this.operatorRole,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  isAdmin(): boolean {
    return this.operatorRole === "admin";
  }
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
