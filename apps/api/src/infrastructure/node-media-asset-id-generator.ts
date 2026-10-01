import { randomBytes } from "node:crypto";
import { createUuidV7, type Instant, mediaAssetId, type MediaAssetId } from "@editagent/domain";

/** Feeds Node crypto entropy into the domain UUIDv7 helper for MediaAsset ids. */
export class NodeMediaAssetIdGenerator {
  next(at: Instant): MediaAssetId {
    return mediaAssetId(createUuidV7(Number(at), randomBytes(10)));
  }
}
