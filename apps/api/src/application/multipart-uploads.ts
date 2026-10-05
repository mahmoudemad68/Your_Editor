import { randomBytes } from "node:crypto";
import {
  createUuidV7,
  uuidV7,
  PART_SIZE_BYTES,
  UPLOAD_SESSION_TTL_MS,
  uploadPartBytes,
  type UploadSessionRepository,
  type UploadSession,
  type UploadPart,
  type LockedUpload,
  type ProjectRepository,
  type ProjectId,
  type UserId,
  type IObjectStorage,
  type MediaAssetRepository,
  MediaAssetConflict,
} from "@editagent/domain";
import { type Clock, type MediaAssetIdGenerator } from "./clock.js";
import {
  checkDeclaration,
  requireUploader,
  withStorage,
  CompleteMediaUpload,
  type UploadDeclaration,
  type UploadPublication,
} from "./uploads.js";
import { ProjectNotFoundError } from "./project-access.js";
import { UploadObjectMismatch, UploadPolicyError } from "./upload-errors.js";

export interface MultipartState {
  readonly session: UploadSession;
  readonly parts: readonly UploadPart[];
}
export class MultipartUploads {
  private readonly completeMedia: CompleteMediaUpload;
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: UploadSessionRepository,
    private readonly objects: IObjectStorage,
    private readonly media: MediaAssetRepository,
    ids: MediaAssetIdGenerator,
    private readonly clock: Clock,
    private readonly presignTtlSeconds: number,
    publication?: UploadPublication,
  ) {
    this.completeMedia = new CompleteMediaUpload(projects, media, objects, ids, clock, publication);
  }
  async start(
    actor: UserId,
    project: ProjectId,
    input: UploadDeclaration,
  ): Promise<MultipartState> {
    await requireUploader(this.projects, project, actor);
    const checked = checkDeclaration(project, input);
    if (/[\\/]/.test(checked.filename))
      throw new UploadPolicyError("The filename must not contain a path.");
    const existing = await this.sessions.findReusable(project, actor, checked.sha256);
    if (existing) {
      const state = await this.sessions.withSession(existing, async (upload) => {
        if (!upload) throw new ProjectNotFoundError();
        const s = upload.session;
        if (s.status !== "completed" && s.expiresAt <= this.clock.now()) {
          await this.expire(upload);
          return null;
        }
        if (
          s.filename !== checked.filename ||
          s.mimeType !== checked.mimeType ||
          s.byteSize !== Number(checked.byteSize)
        )
          throw new UploadObjectMismatch();
        if (s.status === "active") await this.reconcile(upload);
        return this.state(upload);
      });
      if (state) return state;
    }
    const now = this.clock.now();
    const multipartUploadId = await withStorage(() =>
      this.objects.createMultipart(checked.storageKey, checked.mimeType),
    );
    const session: UploadSession = {
      id: createUuidV7(Number(now), randomBytes(10)),
      projectId: project,
      userId: actor,
      storageKey: checked.storageKey,
      multipartUploadId,
      filename: checked.filename,
      mimeType: checked.mimeType,
      byteSize: Number(checked.byteSize),
      sha256: checked.sha256,
      partSize: PART_SIZE_BYTES,
      status: "active",
      mediaAssetId: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + UPLOAD_SESSION_TTL_MS,
    };
    try {
      await this.sessions.create(session);
    } catch (error) {
      await withStorage(() => this.objects.abortMultipart(session.storageKey, multipartUploadId));
      throw error;
    }
    return { session, parts: [] };
  }
  get(actor: UserId, project: ProjectId, id: string): Promise<MultipartState> {
    return this.run(actor, project, id, async (upload) => {
      if (upload.session.status === "active") await this.reconcile(upload);
      return this.state(upload);
    });
  }
  signPart(actor: UserId, project: ProjectId, id: string, partNumber: number) {
    return this.run(actor, project, id, async (upload) => {
      this.active(upload);
      uploadPartBytes(upload.session.byteSize, upload.session.partSize, partNumber);
      await this.reconcile(upload);
      if (upload.parts.some((p) => p.partNumber === partNumber)) throw new UploadObjectMismatch();
      const ttl = Math.min(
        this.presignTtlSeconds,
        Math.max(1, Number((upload.session.expiresAt - this.clock.now()) / 1000n)),
      );
      const signed = await withStorage(() =>
        this.objects.presignPart(
          upload.session.storageKey,
          upload.session.multipartUploadId,
          partNumber,
          ttl,
          uploadPartBytes(upload.session.byteSize, upload.session.partSize, partNumber),
        ),
      );
      return { ...signed, expiresAt: (this.clock.now() + BigInt(ttl) * 1000n).toString() };
    });
  }
  recordPart(
    actor: UserId,
    project: ProjectId,
    id: string,
    partNumber: number,
    etag: string,
  ): Promise<MultipartState> {
    return this.run(actor, project, id, async (upload) => {
      this.active(upload);
      uploadPartBytes(upload.session.byteSize, upload.session.partSize, partNumber);
      const provider = await withStorage(() =>
        this.objects.listParts(upload.session.storageKey, upload.session.multipartUploadId),
      );
      const part = provider.find((p) => p.partNumber === partNumber);
      if (!part || part.etag !== etag) throw new UploadObjectMismatch();
      await this.reconcile(upload, provider);
      return this.state(upload);
    });
  }
  complete(actor: UserId, project: ProjectId, id: string, correlationId: string) {
    return this.run(actor, project, id, async (upload) => {
      const s = upload.session;
      if (s.status === "completed") {
        const asset = s.mediaAssetId === null ? null : await this.media.findById(s.mediaAssetId);
        if (!asset) throw new UploadObjectMismatch();
        return asset;
      }
      if (s.status === "active") {
        await this.reconcile(upload);
        const count = Math.ceil(s.byteSize / s.partSize);
        if (upload.parts.length !== count) throw new UploadObjectMismatch();
        for (let n = 1; n <= count; n++)
          if (
            !upload.parts.some(
              (p) =>
                p.partNumber === n && p.byteSize === uploadPartBytes(s.byteSize, s.partSize, n),
            )
          )
            throw new UploadObjectMismatch();
        s.status = "completing";
        s.updatedAt = this.clock.now();
        await upload.save();
      }
      if (s.status !== "completing") throw new UploadObjectMismatch();
      // Completion can be replayed after a crash: provider adapter reconciles a
      // consumed upload id against the existing immutable object.
      await withStorage(() =>
        this.objects.completeMultipart(s.storageKey, s.multipartUploadId, upload.parts),
      );
      let asset;
      try {
        asset = await this.completeMedia.execute(
          actor,
          project,
          { filename: s.filename, mimeType: s.mimeType, byteSize: s.byteSize, sha256: s.sha256 },
          correlationId,
        );
      } catch (error) {
        if (error instanceof UploadObjectMismatch || error instanceof MediaAssetConflict) {
          if (error instanceof UploadObjectMismatch) {
            const stat = await withStorage(() => this.objects.stat(s.storageKey));
            if (stat && stat.checksumSha256Hex !== s.sha256)
              await withStorage(() => this.objects.delete(s.storageKey));
          }
          s.status = "failed";
          s.updatedAt = this.clock.now();
          await upload.save();
        }
        throw error;
      }
      s.status = "completed";
      s.mediaAssetId = asset.id;
      s.updatedAt = this.clock.now();
      await upload.save();
      return asset;
    });
  }
  abort(actor: UserId, project: ProjectId, id: string): Promise<void> {
    return this.run(
      actor,
      project,
      id,
      async (upload) => {
        if (upload.session.status === "completed" || upload.session.status === "completing")
          throw new UploadObjectMismatch();
        await withStorage(() =>
          this.objects.abortMultipart(upload.session.storageKey, upload.session.multipartUploadId),
        );
        if (upload.session.status !== "active") return;
        upload.session.status = "aborted";
        upload.session.updatedAt = this.clock.now();
        await upload.save();
      },
      true,
    );
  }
  async cleanupExpired(limit = 100): Promise<number> {
    const ids = await this.sessions.expired(this.clock.now(), limit);
    let expired = 0;
    for (const id of ids)
      await this.sessions.withSession(id, async (upload) => {
        if (
          upload &&
          ["active", "completing"].includes(upload.session.status) &&
          upload.session.expiresAt <= this.clock.now()
        ) {
          await this.expire(upload);
          expired++;
        }
      });
    return expired;
  }
  private async run<T>(
    actor: UserId,
    project: ProjectId,
    id: string,
    action: (upload: LockedUpload) => Promise<T>,
    allowTerminal = false,
  ): Promise<T> {
    await requireUploader(this.projects, project, actor);
    const canonicalId = uuidV7(id);
    return this.sessions.withSession(canonicalId, async (upload) => {
      if (!upload || upload.session.projectId !== project || upload.session.userId !== actor)
        throw new ProjectNotFoundError();
      const s = upload.session;
      if (["active", "completing"].includes(s.status) && s.expiresAt <= this.clock.now())
        await this.expire(upload);
      if (!allowTerminal && ["expired", "aborted", "failed"].includes(s.status))
        throw new UploadObjectMismatch();
      return action(upload);
    });
  }
  private active(upload: LockedUpload): void {
    if (upload.session.status !== "active") throw new UploadObjectMismatch();
  }
  private state(upload: LockedUpload): MultipartState {
    return {
      session: { ...upload.session },
      parts: [...upload.parts].sort((a, b) => a.partNumber - b.partNumber),
    };
  }
  private async expire(upload: LockedUpload): Promise<void> {
    await withStorage(() =>
      this.objects.abortMultipart(upload.session.storageKey, upload.session.multipartUploadId),
    );
    upload.session.status = "expired";
    upload.session.updatedAt = this.clock.now();
    await upload.save();
  }
  private async reconcile(
    upload: LockedUpload,
    provided?: readonly {
      partNumber: number;
      etag: string;
      byteSize: number;
      checksum: string | null;
    }[],
  ): Promise<void> {
    const s = upload.session;
    const listed =
      provided ??
      (await withStorage(() => this.objects.listParts(s.storageKey, s.multipartUploadId)));
    for (const stored of upload.parts) {
      const part = listed.find((p) => p.partNumber === stored.partNumber);
      if (
        !part ||
        part.etag !== stored.etag ||
        part.byteSize !== stored.byteSize ||
        part.checksum !== stored.checksum
      )
        throw new UploadObjectMismatch();
    }
    for (const part of listed) {
      if (
        part.byteSize !== uploadPartBytes(s.byteSize, s.partSize, part.partNumber) ||
        !part.etag ||
        part.etag.length > 200
      )
        throw new UploadObjectMismatch();
      s.updatedAt = this.clock.now();
      await upload.record({ ...part, uploadSessionId: s.id, completedAt: this.clock.now() });
    }
  }
}
