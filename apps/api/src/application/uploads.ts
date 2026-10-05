import {
  contentSha256,
  displayFilename,
  type IObjectStorage,
  type Instant,
  mediaByteSize,
  MediaAsset,
  MediaAssetConflict,
  type MediaAssetRepository,
  mediaStorageKey,
  type ProjectId,
  type ProjectRepository,
  type UserId,
  videoMimeType,
} from "@editagent/domain";
import { type Clock, type MediaAssetIdGenerator } from "./clock.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";
import {
  ObjectStorageUnavailable,
  UploadObjectMismatch,
  UploadObjectMissing,
  UploadPolicyError,
} from "./upload-errors.js";

export interface UploadDeclaration {
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: bigint | number | string;
  readonly sha256: string;
}

export interface BeginUploadResult {
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly expiresAt: Instant;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface CheckedUpload {
  readonly filename: string;
  readonly mimeType: string;
  readonly byteSize: bigint;
  readonly sha256: string;
  readonly storageKey: string;
}

/**
 * Stores the asset and a recoverable inspect intent together, then attempts
 * publication without making the caller wait on an unreachable broker.
 * The same stored upload returns the existing asset.
 */
export interface UploadPublication {
  complete(asset: MediaAsset, correlationId: string): Promise<MediaAsset>;
}

/**
 * BeginMediaUpload and CompleteMediaUpload.
 * Membership and object checks stay here. Controllers do not build storage keys.
 */

export function checkDeclaration(projectId: ProjectId, input: UploadDeclaration): CheckedUpload {
  try {
    const filename = displayFilename(input.filename);
    const mimeType = videoMimeType(input.mimeType);
    const byteSize = mediaByteSize(input.byteSize);
    const sha256 = contentSha256(input.sha256);
    return {
      filename,
      mimeType,
      byteSize,
      sha256,
      storageKey: mediaStorageKey(projectId, sha256),
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new UploadPolicyError(error.message);
    }
    throw new UploadPolicyError("The upload is not allowed.");
  }
}

export async function requireUploader(
  projects: ProjectRepository,
  projectId: ProjectId,
  actorUserId: UserId,
): Promise<void> {
  const loaded = await projects.findById(projectId);
  if (
    loaded === null ||
    !loaded.project.isListed() ||
    loaded.project.roleOf(actorUserId) === null
  ) {
    throw new ProjectNotFoundError();
  }
  const role = loaded.project.roleOf(actorUserId);
  if (role !== "owner" && role !== "editor") {
    throw new ProjectForbiddenError("Only an Owner or Editor can upload media.");
  }
}

export async function withStorage<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof UploadObjectMissing ||
      error instanceof UploadObjectMismatch ||
      error instanceof UploadPolicyError ||
      error instanceof ProjectNotFoundError ||
      error instanceof ProjectForbiddenError
    ) {
      throw error;
    }
    throw new ObjectStorageUnavailable();
  }
}

export class BeginMediaUpload {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly objects: IObjectStorage,
    private readonly clock: Clock,
    private readonly presignTtlSeconds: number,
  ) {}

  async execute(
    actorUserId: UserId,
    projectId: ProjectId,
    input: UploadDeclaration,
  ): Promise<BeginUploadResult> {
    await requireUploader(this.projects, projectId, actorUserId);
    const checked = checkDeclaration(projectId, input);
    const presigned = await this.objects.presignPut({
      key: checked.storageKey,
      contentType: checked.mimeType,
      checksumSha256Hex: checked.sha256,
      expiresInSeconds: this.presignTtlSeconds,
      onlyIfAbsent: true,
    });
    return {
      uploadUrl: presigned.url,
      storageKey: checked.storageKey,
      expiresAt: this.clock.now() + BigInt(this.presignTtlSeconds) * 1000n,
      requiredHeaders: presigned.requiredHeaders,
    };
  }
}

export class CompleteMediaUpload {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly media: MediaAssetRepository,
    private readonly objects: IObjectStorage,
    private readonly ids: MediaAssetIdGenerator,
    private readonly clock: Clock,
    private readonly publication?: UploadPublication,
  ) {}

  async execute(
    actorUserId: UserId,
    projectId: ProjectId,
    input: UploadDeclaration,
    correlationId?: string,
  ): Promise<MediaAsset> {
    await requireUploader(this.projects, projectId, actorUserId);
    const checked = checkDeclaration(projectId, input);
    const stat = await withStorage(() => this.objects.stat(checked.storageKey));
    if (stat === null) {
      throw new UploadObjectMissing();
    }
    const matches =
      stat.byteSize === checked.byteSize &&
      stat.contentType === checked.mimeType &&
      stat.checksumSha256Hex === checked.sha256;
    if (!matches) {
      throw new UploadObjectMismatch();
    }
    const existing = (await this.media.listByProject(projectId)).find(
      (asset) => asset.storageKey === checked.storageKey,
    );
    if (existing !== undefined) {
      if (
        existing.displayFilename !== checked.filename ||
        existing.mimeType !== checked.mimeType ||
        existing.byteSize !== checked.byteSize ||
        existing.contentSha256 !== checked.sha256
      )
        throw new MediaAssetConflict();
      // The production outbox reconciles/delivers an existing publication intent as before.
      if (this.publication === undefined || correlationId === undefined) return existing;
    }
    // FFprobe runs in media-worker. This command does not inspect the object.
    const asset = MediaAsset.createUploaded({
      id: this.ids.next(this.clock.now()),
      projectId,
      createdAt: this.clock.now(),
      displayFilename: checked.filename,
      mimeType: checked.mimeType,
      byteSize: checked.byteSize,
      contentSha256: checked.sha256,
    });
    if (this.publication !== undefined && correlationId !== undefined) {
      return this.publication.complete(asset, correlationId);
    }
    await this.media.save(asset);
    return asset;
  }
}
