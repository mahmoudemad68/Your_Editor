/** Public module id. Other modules must not import this folder. */
export const identityModule = "identity" as const;

export { RefreshSession } from "./refresh-session.js";
export type { RefreshSessionSnapshot } from "./refresh-session.js";
export { normalizeEmail, operatorRole, requireArgon2idHash, User } from "./user.js";
export type { OperatorRole, UserSnapshot } from "./user.js";
export type {
  ClearAttemptsResult,
  FailedAttemptResult,
  RefreshRotation,
  RefreshSessionRepository,
  RotationDecision,
  UserRepository,
} from "./user-repository.js";
