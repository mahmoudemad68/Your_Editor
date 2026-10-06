export const productName = "EditAgent";

export {
  ConfigurationError,
  parseAgentWorkerConfig,
  parseApiConfig,
  parseMediaWorkerConfig,
  parseRenderWorkerConfig,
  parseWebConfig,
} from "./config.js";
export type {
  AgentWorkerConfig,
  ApiConfig,
  EnvSource,
  ObjectStorageConfig,
  StorageWorkerConfig,
  WebConfig,
} from "./config.js";
export { keepProcessAlive, processReadyFilePath } from "./lifecycle.js";
export {
  CORRELATION_HEADER,
  acceptCorrelationId,
  bindCorrelationId,
  createCorrelationId,
  createLoggedJob,
  currentCorrelationId,
  parseLoggedJob,
} from "./correlation.js";
export type { LoggedJob } from "./correlation.js";
export { createServiceLogger, logWithCorrelation } from "./logger.js";
export type { JsonLogger } from "./logger.js";
export { startNoopTracing } from "./tracing.js";
export { WORKER_HEALTH_PORT, startHealthServer } from "./health-server.js";

export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export {
  VIDEO_CODECS,
  AUDIO_CODECS,
  parseValidationPolicy,
  validationPolicySignature,
  assertInspectionTimeoutBudget,
  MEDIA_INSPECT_TIMEOUT_MS,
  MEDIA_INSPECT_OPERATIONAL_HEADROOM_MS,
  MAX_VALIDATION_SUBPROCESS_TIMEOUT_MS,
  type ValidationPolicy,
} from "./media-validation-policy.js";
