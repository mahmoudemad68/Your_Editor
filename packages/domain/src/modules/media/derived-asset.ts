/**
 * A product of a MediaAsset. It is not itself a MediaAsset.
 * The constructor validates kind and timestamps. US-128 adds validated durable artifact information without adapter types.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import {
  derivedAssetId,
  type DerivedAssetId,
  mediaAssetId,
  type MediaAssetId,
  projectId,
} from "../../kernel/id.js";

export type DerivedAssetKind = "proxy" | "extracted-audio" | "thumbnail";

export interface DerivedArtifact {
  readonly projectId: string;
  readonly storageKey: string;
  readonly parameterSignature: string;
  readonly mimeType: string;
  readonly byteSize: string;
  readonly sha256: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DerivedAssetSnapshot {
  readonly id: string;
  readonly mediaAssetId: string;
  readonly kind: string;
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
  readonly artifact?: DerivedArtifact | null;
}

export class DerivedAsset {
  readonly id: DerivedAssetId;
  readonly mediaAssetId: MediaAssetId;
  readonly kind: DerivedAssetKind;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly artifact: DerivedArtifact | null;

  constructor(
    id: DerivedAssetId | string,
    mediaAssetIdValue: MediaAssetId | string,
    kind: string,
    createdAt: Instant | string | bigint,
    updatedAt?: Instant | string | bigint,
    artifact: DerivedArtifact | null = null,
  ) {
    const created = instant(createdAt);
    this.id = derivedAssetId(String(id));
    this.mediaAssetId = mediaAssetId(String(mediaAssetIdValue));
    this.kind = derivedAssetKind(kind);
    this.createdAt = created;
    this.updatedAt = updatedAt == null ? created : instant(updatedAt);
    requireAuditOrder(this.createdAt, this.updatedAt);
    this.artifact =
      artifact === null ? null : validateArtifact(artifact, this.mediaAssetId, this.kind);
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
      snapshot.artifact ?? null,
    );
  }

  toSnapshot(): DerivedAssetSnapshot {
    return {
      id: this.id,
      mediaAssetId: this.mediaAssetId,
      kind: this.kind,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      artifact: this.artifact,
    };
  }
}

export function derivedAssetKind(value: string): DerivedAssetKind {
  if (value === "proxy" || value === "extracted-audio" || value === "thumbnail") {
    return value;
  }
  throw new DomainError("DerivedAsset kind must be proxy, extracted-audio, or thumbnail.");
}

function validateArtifact(
  value: DerivedArtifact,
  source: string,
  kind: DerivedAssetKind,
): DerivedArtifact {
  const project = projectId(value.projectId);
  if (!/^[0-9a-f]{64}$/.test(value.parameterSignature) || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new DomainError("Derived artifact signature and checksum must be SHA-256.");
  }
  const prefix = `projects/${project}/derived/${source}/${kind}/${value.parameterSignature}/`;
  if (
    !value.storageKey.startsWith(prefix) ||
    !/^(proxy\.mp4|asr\.wav|mix\.wav|poster\.jpg|sprite\.jpg)$/.test(
      value.storageKey.slice(prefix.length),
    )
  ) {
    throw new DomainError("Derived artifact key must belong to its project, source and signature.");
  }
  if (
    !/^[1-9][0-9]*$/.test(value.byteSize) ||
    BigInt(value.byteSize) > 68_719_476_736n ||
    !["video/mp4", "audio/wav", "image/jpeg"].includes(value.mimeType)
  ) {
    throw new DomainError("Derived artifact size or MIME is invalid.");
  }
  const names =
    kind === "proxy"
      ? ["proxy.mp4"]
      : kind === "extracted-audio"
        ? ["asr.wav", "mix.wav"]
        : ["poster.jpg", "sprite.jpg"];
  const name = value.storageKey.slice(prefix.length);
  const mime =
    kind === "proxy" ? "video/mp4" : kind === "extracted-audio" ? "audio/wav" : "image/jpeg";
  if (
    !names.includes(name) ||
    value.mimeType !== mime ||
    value.metadata["variant"] !== name.split(".")[0] ||
    typeof value.metadata["parameters"] !== "object" ||
    value.metadata["parameters"] === null ||
    Array.isArray(value.metadata["parameters"])
  ) {
    throw new DomainError("Derived artifact kind, variant and parameters must agree.");
  }
  const metadata = JSON.parse(JSON.stringify(value.metadata)) as Record<string, unknown>;
  return Object.freeze({ ...value, projectId: project, metadata: freezeMetadata(metadata) });
}

function freezeMetadata<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) freezeMetadata(entry);
    Object.freeze(value);
  }
  return value;
}
