/** Generic operations for schema-owned x-editagent-checks; no contract shapes live here. */
export type ContractRule = Readonly<Record<string, unknown> & { kind: string }>;
function at(value: unknown, path: string): unknown {
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
function records(value: unknown, field: string): Record<string, unknown>[] {
  return (at(value, field) ?? []) as Record<string, unknown>[];
}
export function codePointLength(value: string): number {
  return Array.from(value).length;
}
export function wellFormed(value: string): boolean {
  return !/[\uD800-\uDFFF]/u.test(value);
}
export function checkRules(value: unknown, rules: readonly ContractRule[]): boolean {
  try {
    return applyRules(value, rules);
  } catch {
    return false;
  } // A failed scalar refinement must not make safeParse throw.
}
function applyRules(value: unknown, rules: readonly ContractRule[]): boolean {
  for (const rule of rules) {
    const field = String(rule.field);
    const decimal = rule.decimal === true;
    const n = (v: unknown): number | bigint => (decimal ? BigInt(String(v)) : Number(v));
    const left = at(value, String(rule.left));
    const right = at(value, String(rule.right));
    switch (rule.kind) {
      case "positive":
        if (at(value, field) !== undefined && n(at(value, field)) <= 0) return false;
        break;
      case "maximum":
        if (at(value, field) !== undefined && n(at(value, field)) > n(rule.value)) return false;
        break;
      case "less":
        if (n(left) >= n(right)) return false;
        break;
      case "lessEqual":
        if (n(left) > n(right)) return false;
        break;
      case "sameWhenPresent":
        if (right !== undefined && left !== right) return false;
        break;
      case "together": {
        const fields = rule.fields as string[];
        const count = fields.filter((f) => at(value, f) !== undefined).length;
        if (count !== 0 && count !== fields.length) return false;
        break;
      }
      case "sumMax":
        if (
          (rule.fields as string[]).reduce((sum, f) => sum + Number(at(value, f)), 0) >
          Number(rule.maximum)
        )
          return false;
        break;
      case "unique": {
        const keys = records(value, field).map((item) => at(item, String(rule.key)));
        if (new Set(keys).size !== keys.length) return false;
        break;
      }
      case "nestedCount":
        if (
          records(value, field).reduce(
            (count, item) => count + records(item, String(rule.child)).length,
            0,
          ) > Number(rule.maximum)
        )
          return false;
        break;
      case "orderedRanges": {
        let previous = 0n;
        for (const item of records(value, field)) {
          const start = BigInt(String(at(item, String(rule.start))));
          const end = BigInt(String(at(item, String(rule.end))));
          if (start < previous || start >= end) return false;
          previous = end;
        }
        break;
      }
      case "orderedPoints": {
        let previous = -1n;
        for (const item of records(value, field)) {
          const time = BigInt(String(at(item, String(rule.time))));
          if (time <= previous) return false;
          previous = time;
        }
        break;
      }
      case "rangesWithin":
      case "pointsWithin": {
        const lower = BigInt(String(at(value, String(rule.lower))));
        const upper = BigInt(String(at(value, String(rule.upper))));
        for (const item of records(value, field)) {
          if (rule.kind === "pointsWithin") {
            const time = BigInt(String(at(item, String(rule.time))));
            if (time < lower || time >= upper) return false;
          } else if (
            BigInt(String(at(item, String(rule.start)))) < lower ||
            BigInt(String(at(item, String(rule.end)))) > upper
          )
            return false;
        }
        break;
      }
      case "rotatedDimensions": {
        const width = at(value, String(rule.width));
        const height = at(value, String(rule.height));
        const displayWidth = at(value, String(rule.displayWidth));
        const displayHeight = at(value, String(rule.displayHeight));
        const rotation = at(value, String(rule.rotation));
        if (width === undefined) {
          if (rotation !== undefined) return false;
        } else {
          const swaps = rotation === 90 || rotation === 270;
          if (
            displayWidth !== (swaps ? height : width) ||
            displayHeight !== (swaps ? width : height)
          )
            return false;
        }
        break;
      }
      case "timesWithin": {
        const duration = at(value, String(rule.duration));
        const keys = rule.timeKeys as string[];
        const walk = (item: unknown): boolean => {
          if (Array.isArray(item)) return item.every(walk);
          if (!item || typeof item !== "object") return true;
          return Object.entries(item).every(([key, v]) =>
            keys.includes(key)
              ? duration !== undefined && BigInt(String(v)) <= BigInt(String(duration))
              : walk(v),
          );
        };
        if (!(rule.fields as string[]).every((f) => walk(at(value, f)))) return false;
        break;
      }
      default:
        throw new Error("Unsupported schema-owned contract rule");
    }
  }
  return true;
}
