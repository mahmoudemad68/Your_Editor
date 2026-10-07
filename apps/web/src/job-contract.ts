import type { components } from "./generated/schema";
import type { JobEvent } from "@editagent/schemas";
export type InspectionJob = components["schemas"]["InspectionJobDto"];
export interface JobStatusApi {
  snapshot(projectId: string, mediaId: string, signal: AbortSignal): Promise<InspectionJob | null>;
  retry(projectId: string, mediaId: string, signal: AbortSignal): Promise<InspectionJob>;
}
/** One project stream can have many media consumers. No per-card network connection. */
export interface JobEventStream {
  subscribe(
    projectId: string,
    listener: { event: (event: JobEvent) => void; reconcile: () => void },
  ): () => void;
}
