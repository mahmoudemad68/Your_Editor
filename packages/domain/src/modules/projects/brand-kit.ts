/**
 * Canonical BrandKit. Projects owns the record.
 * Applying it during an edit is a later story (US-521). This type does not render.
 */

import { type Instant, instant, requireAuditOrder } from "../../kernel/clock.js";
import { type BrandKitId, brandKitId, type ProjectId, projectId } from "../../kernel/id.js";

export class BrandKit {
  readonly id: BrandKitId;
  readonly projectId: ProjectId;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  constructor(
    id: BrandKitId | string,
    projectIdValue: ProjectId | string,
    createdAt: Instant | string | bigint,
    updatedAt?: Instant | string | bigint,
  ) {
    const created = instant(createdAt);
    this.id = brandKitId(String(id));
    this.projectId = projectId(String(projectIdValue));
    this.createdAt = created;
    this.updatedAt = updatedAt == null ? created : instant(updatedAt);
    requireAuditOrder(this.createdAt, this.updatedAt);
    Object.freeze(this);
  }

  static create(id: BrandKitId, projectIdValue: ProjectId, createdAt: Instant): BrandKit {
    return new BrandKit(id, projectIdValue, createdAt, createdAt);
  }
}
