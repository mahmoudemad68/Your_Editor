import {
  type RefreshSession,
  type RefreshSessionRepository,
  type User,
  type UserId,
  type UserRepository,
} from "@editagent/domain";

export class InMemoryUserRepository implements UserRepository {
  private readonly byId = new Map<string, User>();

  async findById(id: UserId): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    for (const user of this.byId.values()) {
      if (user.email === email) {
        return user;
      }
    }
    return null;
  }

  async save(user: User): Promise<void> {
    this.byId.set(user.id, user);
  }
}

export class InMemoryRefreshSessionRepository implements RefreshSessionRepository {
  private readonly byId = new Map<string, RefreshSession>();

  async findById(id: string): Promise<RefreshSession | null> {
    return this.byId.get(id) ?? null;
  }

  async save(session: RefreshSession): Promise<void> {
    this.byId.set(session.id, session);
  }

  async revokeAllForUser(userId: UserId, revokedAt: bigint): Promise<void> {
    for (const session of this.byId.values()) {
      if (session.userId === userId) {
        this.byId.set(session.id, session.revoke(revokedAt));
      }
    }
  }
}
