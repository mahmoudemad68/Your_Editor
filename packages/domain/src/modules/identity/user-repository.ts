import { type UserId } from "../../kernel/id.js";
import { type User } from "./user.js";

/** Persistence port. The Postgres adapter is a later Identity story, not this model. */
export interface UserRepository {
  findById(id: UserId): Promise<User | null>;
  save(user: User): Promise<void>;
}
