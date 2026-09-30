/**
 * UUIDv7 identifiers (RFC 9562). The domain validates and mints them.
 * It does not import a database driver or Node's crypto module.
 * Persistence adapters may store the same value as a UUID column (US-120).
 */

import { DomainError } from "./error.js";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

declare const uuidV7Brand: unique symbol;
export type UuidV7 = string & { readonly [uuidV7Brand]: "UuidV7" };

declare const userIdBrand: unique symbol;
declare const projectIdBrand: unique symbol;
declare const mediaAssetIdBrand: unique symbol;
declare const derivedAssetIdBrand: unique symbol;
declare const jobIdBrand: unique symbol;
declare const timelineIdBrand: unique symbol;
declare const trackIdBrand: unique symbol;
declare const clipIdBrand: unique symbol;
declare const effectIdBrand: unique symbol;
declare const toolIdBrand: unique symbol;
declare const componentIdBrand: unique symbol;
declare const agentRunIdBrand: unique symbol;
declare const critiqueIdBrand: unique symbol;
declare const brandKitIdBrand: unique symbol;
declare const creativeMemoryIdBrand: unique symbol;

export type UserId = UuidV7 & { readonly [userIdBrand]: "UserId" };
export type ProjectId = UuidV7 & { readonly [projectIdBrand]: "ProjectId" };
export type MediaAssetId = UuidV7 & { readonly [mediaAssetIdBrand]: "MediaAssetId" };
export type DerivedAssetId = UuidV7 & { readonly [derivedAssetIdBrand]: "DerivedAssetId" };
export type JobId = UuidV7 & { readonly [jobIdBrand]: "JobId" };
export type TimelineId = UuidV7 & { readonly [timelineIdBrand]: "TimelineId" };
export type TrackId = UuidV7 & { readonly [trackIdBrand]: "TrackId" };
export type ClipId = UuidV7 & { readonly [clipIdBrand]: "ClipId" };
export type EffectId = UuidV7 & { readonly [effectIdBrand]: "EffectId" };
export type ToolId = UuidV7 & { readonly [toolIdBrand]: "ToolId" };
export type ComponentId = UuidV7 & { readonly [componentIdBrand]: "ComponentId" };
export type AgentRunId = UuidV7 & { readonly [agentRunIdBrand]: "AgentRunId" };
export type CritiqueId = UuidV7 & { readonly [critiqueIdBrand]: "CritiqueId" };
export type BrandKitId = UuidV7 & { readonly [brandKitIdBrand]: "BrandKitId" };
export type CreativeMemoryId = UuidV7 & { readonly [creativeMemoryIdBrand]: "CreativeMemoryId" };

export function uuidV7(value: string): UuidV7 {
  const normalized = value.toLowerCase();
  if (!UUID_V7.test(normalized)) {
    throw new DomainError("Identifier must be a canonical UUIDv7.");
  }
  return normalized as UuidV7;
}

/** 48-bit Unix millisecond timestamp plus 10 entropy bytes. Version nibble is 7. */
export function createUuidV7(timestampMs: number, entropy: Uint8Array): UuidV7 {
  if (!Number.isInteger(timestampMs) || timestampMs < 0 || timestampMs > 2 ** 48 - 1) {
    throw new DomainError("UUIDv7 timestamp must be a non-negative integer of at most 48 bits.");
  }
  if (entropy.length < 10) {
    throw new DomainError("UUIDv7 needs at least 10 entropy bytes.");
  }
  const bytes = new Uint8Array(16);
  bytes[0] = byteAt(timestampMs, 40);
  bytes[1] = byteAt(timestampMs, 32);
  bytes[2] = byteAt(timestampMs, 24);
  bytes[3] = byteAt(timestampMs, 16);
  bytes[4] = byteAt(timestampMs, 8);
  bytes[5] = byteAt(timestampMs, 0);
  bytes[6] = 0x70 | (entropy[0]! & 0x0f);
  bytes[7] = entropy[1]!;
  bytes[8] = 0x80 | (entropy[2]! & 0x3f);
  bytes[9] = entropy[3]!;
  bytes[10] = entropy[4]!;
  bytes[11] = entropy[5]!;
  bytes[12] = entropy[6]!;
  bytes[13] = entropy[7]!;
  bytes[14] = entropy[8]!;
  bytes[15] = entropy[9]!;
  return uuidV7(formatUuid(bytes));
}

export function userId(value: string): UserId {
  return uuidV7(value) as UserId;
}

export function projectId(value: string): ProjectId {
  return uuidV7(value) as ProjectId;
}

export function mediaAssetId(value: string): MediaAssetId {
  return uuidV7(value) as MediaAssetId;
}

export function derivedAssetId(value: string): DerivedAssetId {
  return uuidV7(value) as DerivedAssetId;
}

export function jobId(value: string): JobId {
  return uuidV7(value) as JobId;
}

export function timelineId(value: string): TimelineId {
  return uuidV7(value) as TimelineId;
}

export function trackId(value: string): TrackId {
  return uuidV7(value) as TrackId;
}

export function clipId(value: string): ClipId {
  return uuidV7(value) as ClipId;
}

export function effectId(value: string): EffectId {
  return uuidV7(value) as EffectId;
}

export function toolId(value: string): ToolId {
  return uuidV7(value) as ToolId;
}

export function componentId(value: string): ComponentId {
  return uuidV7(value) as ComponentId;
}

export function agentRunId(value: string): AgentRunId {
  return uuidV7(value) as AgentRunId;
}

export function critiqueId(value: string): CritiqueId {
  return uuidV7(value) as CritiqueId;
}

export function brandKitId(value: string): BrandKitId {
  return uuidV7(value) as BrandKitId;
}

export function creativeMemoryId(value: string): CreativeMemoryId {
  return uuidV7(value) as CreativeMemoryId;
}

function byteAt(value: number, shift: number): number {
  return Math.floor(value / 2 ** shift) & 0xff;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
