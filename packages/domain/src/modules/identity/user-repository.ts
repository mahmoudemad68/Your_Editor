import { type UserId } from "../../kernel/id.js";
import { type RefreshSession } from "./refresh-session.js";
import { type User } from "./user.js";

/** Persistence port for accounts. Email lookup enforces uniqueness. */
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<void>;
}

export interface RefreshSessionRepository {
  findById(id: string): Promise<RefreshSession | null>;
  save(session: RefreshSession): Promise<void>;
  revokeAllForUser(userId: UserId, revokedAt: bigint): Promise<void>;
}
