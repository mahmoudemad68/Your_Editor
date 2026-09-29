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

export class AppError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}
