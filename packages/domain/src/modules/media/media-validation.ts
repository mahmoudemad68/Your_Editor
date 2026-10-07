/** Durable hostile-file verdict; technical inspection alone never authorizes processing. */
import { DomainError } from "../../kernel/error.js";
import { instant, type Instant } from "../../kernel/clock.js";
import { contentSha256 } from "./media-upload.js";

export const MEDIA_REJECTION_MESSAGES = {
  empty_media: "The media is empty.",
  invalid_signature: "The file is not recognized media.",
  unsupported_container: "The media container is unsupported.",
  unsupported_codec: "The media codec is unsupported.",
  duration_limit_exceeded: "The media duration exceeds the allowed limit.",
  resolution_limit_exceeded: "The media resolution exceeds the allowed limit.",
  stream_count_limit_exceeded: "The media has too many streams.",
  file_size_limit_exceeded: "The media exceeds the allowed file size.",
  bitrate_limit_exceeded: "The media bitrate exceeds the allowed limit.",
  invalid_metadata: "The media metadata is invalid.",
  corrupt_media: "The media is corrupt or incomplete.",
  decode_validation_failed: "The media could not be decoded safely.",
  resource_limit_exceeded: "The media exceeded validation resource limits.",
  unsafe_external_reference: "External media references are not allowed.",
  source_identity_mismatch: "The stored media does not match the uploaded source.",
} as const;
export type MediaRejectionCode = keyof typeof MEDIA_REJECTION_MESSAGES;
export interface MediaValidationState {
  readonly status: "pending" | "validated" | "rejected";
  readonly policySignature: string | null;
  readonly sourceSha256: string | null;
  readonly checkedAt: Instant | null;
  readonly rejectionCode: MediaRejectionCode | null;
}
export interface MediaValidationSnapshot {
  readonly status: string;
  readonly policySignature: string | null;
  readonly sourceSha256: string | null;
  readonly checkedAt: bigint | string | null;
  readonly rejectionCode: string | null;
}
export function mediaValidation(snapshot?: MediaValidationSnapshot | null): MediaValidationState {
  if (snapshot == null || snapshot.status === "pending") {
    if (
      snapshot &&
      [
        snapshot.policySignature,
        snapshot.sourceSha256,
        snapshot.checkedAt,
        snapshot.rejectionCode,
      ].some((v) => v !== null)
    )
      throw new DomainError("Pending validation has no verdict.");
    return Object.freeze({
      status: "pending",
      policySignature: null,
      sourceSha256: null,
      checkedAt: null,
      rejectionCode: null,
    });
  }
  if (snapshot.status !== "validated" && snapshot.status !== "rejected")
    throw new DomainError("Invalid media validation state.");
  if (
    snapshot.policySignature === null ||
    snapshot.sourceSha256 === null ||
    snapshot.checkedAt === null
  )
    throw new DomainError("Media validation requires policy, source and time.");
  if (
    snapshot.status === "validated"
      ? snapshot.rejectionCode !== null
      : !Object.hasOwn(MEDIA_REJECTION_MESSAGES, snapshot.rejectionCode ?? "")
  )
    throw new DomainError("Invalid media rejection code.");
  return Object.freeze({
    status: snapshot.status,
    policySignature: contentSha256(snapshot.policySignature),
    sourceSha256: contentSha256(snapshot.sourceSha256),
    checkedAt: instant(snapshot.checkedAt),
    rejectionCode: snapshot.rejectionCode as MediaRejectionCode | null,
  });
}
