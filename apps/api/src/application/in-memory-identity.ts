import {
  type ClearAttemptsResult,
  type FailedAttemptResult,
  type RefreshRotation,
  type RefreshSession,
  type RefreshSessionRepository,
  type RotationDecision,
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

  async recordFailedAttempt(
    id: UserId,
    now: bigint,
    limit: number,
    lockForMs: bigint,
  ): Promise<FailedAttemptResult> {
    const user = this.byId.get(id);
    if (user === undefined) {
      return "missing";
    }
    if (user.isLocked(now)) {
      return "locked";
    }
    this.byId.set(id, user.recordFailedLogin(now, limit, lockForMs));
    return "recorded";
  }

  async clearFailedAttempts(id: UserId, now: bigint): Promise<ClearAttemptsResult> {
    const user = this.byId.get(id);
    if (user === undefined) {
      return "missing";
    }
    if (user.isLocked(now)) {
      return "locked";
    }
    if (user.failedLoginCount !== 0 || user.lockedUntil !== null) {
      this.byId.set(id, user.clearFailedLogins(now));
    }
    return "cleared";
  }
}

export class InMemoryRefreshSessionRepository implements RefreshSessionRepository {
  private readonly byId = new Map<string, RefreshSession>();
  private tail: Promise<void> = Promise.resolve();

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

  async rotate(
    sessionId: string,
    now: bigint,
    decide: (current: RefreshSession | null) => RotationDecision | Promise<RotationDecision>,
    beforeCommit?: (replacement: RefreshSession) => Promise<void>,
  ): Promise<RefreshRotation> {
    return this.exclusive(async () => {
      const current = this.byId.get(sessionId) ?? null;
      const decision = await decide(current);
      if (decision.action === "reject" || current === null) {
        return { outcome: "rejected" };
      }
      if (decision.action === "reuse" || !current.isActive(now)) {
        await this.revokeAllForUser(current.userId, now);
        return { outcome: "reused", userId: current.userId };
      }
      if (
        decision.replacement.userId !== current.userId ||
        decision.replacement.rotatedFromId !== current.id
      ) {
        throw new Error("Replacement session does not continue the presented session.");
      }
      const snapshot = new Map(this.byId);
      this.byId.set(current.id, current.revoke(now));
      this.byId.set(decision.replacement.id, decision.replacement);
      try {
        await beforeCommit?.(decision.replacement);
      } catch (error) {
        this.byId.clear();
        for (const [id, session] of snapshot) {
          this.byId.set(id, session);
        }
        throw error;
      }
      return {
        outcome: "consumed",
        userId: current.userId,
        replacement: decision.replacement,
      };
    });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
