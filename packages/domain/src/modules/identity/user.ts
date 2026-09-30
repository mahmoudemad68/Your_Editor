/**
 * Identity aggregate. Credentials and sessions are US-118.
 * The Admin operator role does not create a Project membership.
 */

import { type AuditStamp, type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type UserId } from "../../kernel/id.js";

/** Operator role. It is not Owner, Editor, or Viewer. */
export type OperatorRole = "admin";

export class User {
  readonly id: UserId;
  readonly operatorRole: OperatorRole | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  private constructor(id: UserId, operatorRole: OperatorRole | null, audit: AuditStamp) {
    this.id = id;
    this.operatorRole = operatorRole;
    this.createdAt = audit.createdAt;
    this.updatedAt = audit.updatedAt;
  }

  static create(id: UserId, createdAt: Instant, operatorRole: OperatorRole | null = null): User {
    const stamp = instant(createdAt);
    return new User(id, operatorRole, { createdAt: stamp, updatedAt: stamp });
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
