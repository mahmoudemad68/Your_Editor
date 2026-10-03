import { boundedModules } from "@editagent/domain";

export interface HealthStatus {
  readonly status: "ok";
  readonly modules: number;
}

export function getHealthStatus(): HealthStatus {
  return { status: "ok", modules: boundedModules.length };
}

export interface ReadyStatus {
  readonly status: "ready" | "not-ready";
}

export interface ReadinessProbe {
  check(): Promise<boolean>;
}

/** Ready means dependencies answered. Health does not call this. */
export function getReadyStatus(ready: boolean): ReadyStatus {
  return { status: ready ? "ready" : "not-ready" };
}
