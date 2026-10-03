/**
 * Runs a job handler where the coordinator can reap it.
 * The implementation lives in infrastructure. This file has no Redis types.
 */

import { type JobEnvelope } from "@editagent/domain";

export interface IsolatedHandler {
  readonly modulePath: string;
  readonly exportName: string;
}

export interface JobSupervisor {
  run(envelope: JobEnvelope, handler: IsolatedHandler, signal: AbortSignal): Promise<void>;
}
