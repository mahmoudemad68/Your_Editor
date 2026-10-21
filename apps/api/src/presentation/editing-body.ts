import { BadRequestException } from "@nestjs/common";
export const EDITING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const EDITING_HASH = /^[a-f0-9]{64}$/;
export const EDITING_TIME = /^(0|[1-9][0-9]{0,9})$/;
export const EDITING_REQUEST = /^req_[a-f0-9]{32}$/;

/** Small fixed HTTP bodies, following the existing explicit upload/auth validation pattern. */
export function editingBody(
  value: unknown,
  fields: Readonly<Record<string, RegExp>>,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException("Invalid editing parameters.");
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).length !== Object.keys(fields).length ||
    Object.keys(body).some((key) => !Object.hasOwn(fields, key))
  )
    throw new BadRequestException("Invalid editing parameters.");
  const parsed: Record<string, string> = {};
  for (const [key, pattern] of Object.entries(fields)) {
    const item = body[key];
    if (typeof item !== "string" || pattern.exec(item)?.[0] !== item)
      throw new BadRequestException("Invalid editing parameters.");
    parsed[key] = item;
  }
  return parsed;
}
