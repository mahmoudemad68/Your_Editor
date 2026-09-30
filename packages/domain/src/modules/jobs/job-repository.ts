import { type JobId } from "../../kernel/id.js";
import { type Job } from "./job.js";

/** Persistence port. The queue adapter is US-129. This interface has no BullMQ or ORM types. */
export interface JobRepository {
  findById(id: JobId): Promise<Job | null>;
  save(job: Job): Promise<void>;
}
