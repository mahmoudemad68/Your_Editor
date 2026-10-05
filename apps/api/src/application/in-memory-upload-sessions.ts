import {
  type UploadSessionRepository,
  type UploadSession,
  type UploadPart,
  type LockedUpload,
  type ProjectId,
  type UserId,
} from "@editagent/domain";
import { UploadObjectMismatch } from "./upload-errors.js";

export class InMemoryUploadSessionRepository implements UploadSessionRepository {
  readonly sessions = new Map<string, UploadSession>();
  readonly parts = new Map<string, UploadPart[]>();
  private readonly locks = new Map<string, Promise<void>>();
  async create(session: UploadSession): Promise<void> {
    if (this.sessions.has(session.id)) throw new UploadObjectMismatch();
    this.sessions.set(session.id, { ...session });
    this.parts.set(session.id, []);
  }
  async findReusable(projectId: ProjectId, userId: UserId, sha256: string): Promise<string | null> {
    return (
      [...this.sessions.values()].find(
        (s) =>
          s.projectId === projectId &&
          s.userId === userId &&
          s.sha256 === sha256 &&
          ["active", "completing", "completed"].includes(s.status),
      )?.id ?? null
    );
  }
  async withSession<T>(
    id: string,
    action: (upload: LockedUpload | null) => Promise<T>,
  ): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(id, next);
    await previous;
    try {
      const stored = this.sessions.get(id);
      if (!stored) return await action(null);
      const session = { ...stored },
        parts = [...(this.parts.get(id) ?? [])];
      const save = async () => {
        this.sessions.set(id, { ...session });
      };
      return await action({
        session,
        parts,
        save,
        record: async (part) => {
          if (session.status !== "active") throw new UploadObjectMismatch();
          const previous = parts.find((p) => p.partNumber === part.partNumber);
          if (
            previous &&
            (previous.etag !== part.etag ||
              previous.byteSize !== part.byteSize ||
              previous.checksum !== part.checksum)
          )
            throw new UploadObjectMismatch();
          if (!previous) {
            parts.push(part);
            this.parts.set(id, [...parts]);
          }
          await save();
        },
      });
    } finally {
      release();
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  async expired(now: bigint, limit: number): Promise<readonly string[]> {
    return [...this.sessions.values()]
      .filter((s) => ["active", "completing"].includes(s.status) && s.expiresAt <= now)
      .slice(0, limit)
      .map((s) => s.id);
  }
}
