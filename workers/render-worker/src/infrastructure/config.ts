import {
  parseRenderWorkerConfig,
  type EnvSource,
  type StorageWorkerConfig,
} from "@editagent/shared";

export type { StorageWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for render-worker configuration. Reads the environment once. */
export function loadRenderWorkerConfig(
  env: EnvSource = process.env,
): StorageWorkerConfig & { renderTimeoutMs: number; renderQueue: string } {
  const base = parseRenderWorkerConfig(env);
  const timeout =
    env["EDITAGENT_RENDER_TIMEOUT_MS"] === undefined
      ? 300000
      : Number(env["EDITAGENT_RENDER_TIMEOUT_MS"]);
  const renderQueue = env["EDITAGENT_RENDER_QUEUE"] ?? "render-remotion-v1";
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1000 ||
    timeout > 600000 ||
    !/^render-[a-z0-9-]{1,48}$/.test(renderQueue)
  )
    throw new Error("Invalid render worker configuration.");
  return { ...base, renderTimeoutMs: timeout, renderQueue };
}
