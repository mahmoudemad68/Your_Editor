import { DomainError } from "../../kernel/error.js";

export function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new DomainError("Expected a plain data object.");
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => ![...required, ...optional].includes(key)) ||
    required.some((key) => !Object.hasOwn(data, key))
  )
    throw new DomainError("Unsupported or missing data field.");
  return data;
}
export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new DomainError("Expected a data array.");
  return value;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 10000)
    throw new DomainError("Expected nonempty bounded text.");
  return value;
}
export function numeric(value: unknown, min: number, max: number, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new DomainError("Invalid numeric property.");
  return value;
}
export function unique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new DomainError("Duplicate entity identifier.");
}
