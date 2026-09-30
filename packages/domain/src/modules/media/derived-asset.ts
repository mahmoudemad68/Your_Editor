/**
 * A product of a MediaAsset. It is not itself a MediaAsset.
 * The constructor validates kind and timestamps. Storage adapters are later stories.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import {
  derivedAssetId,
  type DerivedAssetId,
  mediaAssetId,
  type MediaAssetId,
} from "../../kernel/id.js";

export type DerivedAssetKind = "proxy" | "extracted-audio" | "thumbnail";

export interface DerivedAssetSnapshot {
  readonly id: string;
  readonly mediaAssetId: string;
  readonly kind: string;
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
}

export class DerivedAsset {
  readonly id: DerivedAssetId;
  readonly mediaAssetId: MediaAssetId;
  readonly kind: DerivedAssetKind;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  constructor(
    id: DerivedAssetId | string,
    mediaAssetIdValue: MediaAssetId | string,
    kind: string,
    createdAt: Instant | string | bigint,
    updatedAt?: Instant | string | bigint,
  ) {
    const created = instant(createdAt);
    this.id = derivedAssetId(String(id));
    this.mediaAssetId = mediaAssetId(String(mediaAssetIdValue));
    this.kind = derivedAssetKind(kind);
    this.createdAt = created;
    this.updatedAt = updatedAt == null ? created : instant(updatedAt);
    requireAuditOrder(this.createdAt, this.updatedAt);
    Object.freeze(this);
  }

  static create(
    id: DerivedAssetId,
    mediaAssetIdValue: MediaAssetId,
    kind: string,
    createdAt: Instant,
  ): DerivedAsset {
    return new DerivedAsset(id, mediaAssetIdValue, kind, createdAt, createdAt);
  }

  /** Rebuild a persisted DerivedAsset. Does not regenerate bytes. */
  static restore(snapshot: DerivedAssetSnapshot): DerivedAsset {
    return new DerivedAsset(
      snapshot.id,
      snapshot.mediaAssetId,
      snapshot.kind,
      snapshot.createdAt,
      snapshot.updatedAt,
    );
  }

  toSnapshot(): DerivedAssetSnapshot {
    return {
      id: this.id,
      mediaAssetId: this.mediaAssetId,
      kind: this.kind,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

export function derivedAssetKind(value: string): DerivedAssetKind {
  if (value === "proxy" || value === "extracted-audio" || value === "thumbnail") {
    return value;
  }
  throw new DomainError("DerivedAsset kind must be proxy, extracted-audio, or thumbnail.");
}
