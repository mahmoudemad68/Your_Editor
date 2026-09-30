/**
 * Wall-clock instant for audit and soft-delete columns.
 * This is Unix epoch milliseconds as an integer. It is not media time.
 * Timeline positions stay in integer microseconds (ADR-008).
 */

import { DomainError } from "./error.js";

const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;

export type Instant = bigint;

export function instant(value: bigint | string): Instant {
  const parsed = typeof value === "bigint" ? value : parseCanonicalInteger(value);
  if (parsed < 0n) {
    throw new RangeError(
      "An audit instant must be a non-negative integer number of epoch milliseconds.",
    );
  }
  return parsed;
}

export interface AuditStamp {
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface SoftDeletion {
  readonly deletedAt: Instant | null;
}

export function isNotDeleted(record: SoftDeletion): boolean {
  return record.deletedAt === null;
}

/** Audit history cannot move backwards. Both values must already be instants. */
export function requireAuditOrder(createdAt: Instant, updatedAt: Instant): void {
  if (createdAt > updatedAt) {
    throw new DomainError("createdAt must be less than or equal to updatedAt.");
  }
}

function parseCanonicalInteger(value: string): bigint {
  if (!CANONICAL_INTEGER.test(value)) {
    throw new RangeError("An audit instant must be a canonical decimal integer string.");
  }
  return BigInt(value);
}
