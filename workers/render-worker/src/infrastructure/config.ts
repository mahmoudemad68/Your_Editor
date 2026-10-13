import {
  parseRenderWorkerConfig,
  type EnvSource,
  type StorageWorkerConfig,
} from "@editagent/shared";

export type { StorageWorkerConfig };
export { ConfigurationError } from "@editagent/shared";

/** Process boundary for render-worker configuration. Reads the environment once. */
export function loadRenderWorkerConfig(env: EnvSource = process.env): StorageWorkerConfig & {
  renderTimeoutMs: number;
  renderQueue: string;
  editingCostMicros: number;
  editingProjectBudgetMicros: number;
} {
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
  const editingCostMicros = Number(env["EDITAGENT_EDITING_COST_MICROS"] ?? "1000"),
    editingProjectBudgetMicros = Number(
      env["EDITAGENT_EDITING_PROJECT_BUDGET_MICROS"] ?? "1000000",
    );
  if (
    !Number.isSafeInteger(editingCostMicros) ||
    editingCostMicros < 0 ||
    editingCostMicros > 1000000 ||
    !Number.isSafeInteger(editingProjectBudgetMicros) ||
    editingProjectBudgetMicros < editingCostMicros
  )
    throw new Error("Invalid editing cost configuration.");
  return {
    ...base,
    renderTimeoutMs: timeout,
    renderQueue,
    editingCostMicros,
    editingProjectBudgetMicros,
  };
}

/** Credential-free executor/child configuration; browser identity is never a job input. */
export function loadRendererProcessConfig(env: EnvSource = process.env): {
  concurrency: number;
  browserExecutable: string;
  path: string;
} {
  for (const key of Object.keys(env))
    if (/^(DATABASE_URL|REDIS_URL|S3_|AWS_|AUTH_)/.test(key))
      throw new Error("Credentials are forbidden in the browser runtime.");
  const concurrency = Number(env["REMOTION_CONCURRENCY"] ?? "2");
  const browserExecutable = "/opt/chromium/chrome-headless-shell-linux64/chrome-headless-shell";
  const executable = env["REMOTION_BROWSER"] ?? browserExecutable;
  const path = env["PATH"] ?? "/usr/bin:/bin";
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4 ||
    executable !== browserExecutable ||
    path.includes("\0")
  )
    throw new Error("Invalid renderer process configuration.");
  return { concurrency, browserExecutable, path };
}
