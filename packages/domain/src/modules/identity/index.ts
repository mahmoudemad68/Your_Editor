/** Public module id. Other modules must not import this folder. */
export const identityModule = "identity" as const;

export { operatorRole, User } from "./user.js";
export type { OperatorRole } from "./user.js";
export type { UserRepository } from "./user-repository.js";
