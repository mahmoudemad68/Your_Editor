import { randomBytes } from "node:crypto";
import { createUuidV7, type Instant, projectId, type ProjectId } from "@editagent/domain";

/** Feeds Node crypto entropy into the domain UUIDv7 helper. */
export class NodeProjectIdGenerator {
  next(at: Instant): ProjectId {
    return projectId(createUuidV7(Number(at), randomBytes(10)));
  }
}
