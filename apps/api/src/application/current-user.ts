import type { UserId, UserRepository } from "@editagent/domain";

/** Only the verified request actor can select the session identity. */
export class GetCurrentUser {
  constructor(private readonly users: UserRepository) {}

  async execute(id: UserId): Promise<{ id: string; email: string } | null> {
    const user = await this.users.findById(id);
    return user === null ? null : { id: user.id, email: user.email };
  }
}
