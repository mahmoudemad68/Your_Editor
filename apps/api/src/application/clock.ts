import { type Instant, type ProjectId } from "@editagent/domain";

/** Wall clock for Project commands. Tests supply a fixed instant. */
export interface Clock {
  now(): Instant;
}

/** Mints a new Project id. Entropy stays outside the domain. */
export interface ProjectIdGenerator {
  next(at: Instant): ProjectId;
}
