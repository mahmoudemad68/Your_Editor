import { boundedModules } from "@editagent/domain";

export interface HealthStatus {
  readonly status: "ok";
  readonly modules: number;
}

export function getHealthStatus(): HealthStatus {
  return { status: "ok", modules: boundedModules.length };
}

export interface ReadyStatus {
  readonly status: "ready";
}

export function getReadyStatus(): ReadyStatus {
  return { status: "ready" };
}
