/**
 * Canonical BrandKit. Projects owns the record.
 * Applying it during an edit is a later story (US-521). This type does not render.
 */

import { type AuditStamp, type Instant, instant } from "../../kernel/clock.js";
import { type BrandKitId, type ProjectId } from "../../kernel/id.js";

export class BrandKit {
  readonly id: BrandKitId;
  readonly projectId: ProjectId;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;

  private constructor(id: BrandKitId, projectId: ProjectId, audit: AuditStamp) {
    this.id = id;
    this.projectId = projectId;
    this.createdAt = audit.createdAt;
    this.updatedAt = audit.updatedAt;
  }

  static create(id: BrandKitId, projectId: ProjectId, createdAt: Instant): BrandKit {
    const stamp = instant(createdAt);
    return new BrandKit(id, projectId, { createdAt: stamp, updatedAt: stamp });
  }
}
