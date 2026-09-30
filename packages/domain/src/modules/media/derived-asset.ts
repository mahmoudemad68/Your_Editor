/**
 * A product of a MediaAsset. It is not itself a MediaAsset.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type DerivedAssetId, type MediaAssetId } from "../../kernel/id.js";

export type DerivedAssetKind = "proxy" | "extracted-audio" | "thumbnail";

export class DerivedAsset {
  readonly id: DerivedAssetId;
  readonly mediaAssetId: MediaAssetId;
  readonly kind: DerivedAssetKind;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  private constructor(
    id: DerivedAssetId,
    mediaAssetId: MediaAssetId,
    kind: DerivedAssetKind,
    createdAt: Instant,
  ) {
    this.id = id;
    this.mediaAssetId = mediaAssetId;
    this.kind = kind;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  static create(
    id: DerivedAssetId,
    mediaAssetId: MediaAssetId,
    kind: string,
    createdAt: Instant,
  ): DerivedAsset {
    return new DerivedAsset(id, mediaAssetId, derivedAssetKind(kind), instant(createdAt));
  }
}

export function derivedAssetKind(value: string): DerivedAssetKind {
  if (value === "proxy" || value === "extracted-audio" || value === "thumbnail") {
    return value;
  }
  throw new DomainError("DerivedAsset kind must be proxy, extracted-audio, or thumbnail.");
}
