import { UnauthorizedException } from "@nestjs/common";
import { type UserId } from "@editagent/domain";

const ACTOR_USER_ID = Symbol("editagent.actorUserId");

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
