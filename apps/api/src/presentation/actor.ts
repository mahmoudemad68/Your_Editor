import { UnauthorizedException } from "@nestjs/common";
import { type UserId } from "@editagent/domain";

const ACTOR_USER_ID = Symbol("editagent.actorUserId");
const SESSION_CHECK = Symbol("editagent.sessionCheck");
export function bindSessionCheck(request: object, check: () => Promise<boolean>): void {
  Object.defineProperty(request, SESSION_CHECK, { value: check });
}
export async function sessionStillValid(request: object): Promise<boolean> {
  const check = (request as { [SESSION_CHECK]?: () => Promise<boolean> })[SESSION_CHECK];
  return check === undefined ? false : check();
}

/**
 * Authentication boundary for Project commands.
 * Request authentication calls bindActor only after an access token verifies.
 * This module does not read a user id from the body or from a request header.
 */
export function bindActor(request: object, actorUserId: UserId): void {
  Object.defineProperty(request, ACTOR_USER_ID, { value: actorUserId });
}

export function requireActor(request: object): UserId {
  const actor = (request as { [ACTOR_USER_ID]?: UserId })[ACTOR_USER_ID];
  if (actor === undefined) {
    throw new UnauthorizedException("Sign in is required.");
  }
  return actor;
}
