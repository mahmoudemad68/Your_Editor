import {
  type DerivedAsset,
  type DerivedAssetRepository,
  type IObjectStorage,
  type MediaAsset,
  type MediaAssetId,
  type MediaAssetRepository,
  type ProjectId,
  type ProjectRepository,
  type UserId,
} from "@editagent/domain";
import { GetMediaDetails } from "./media-details.js";
import { ProjectNotFoundError } from "./project-access.js";
import { ObjectStorageUnavailable } from "./upload-errors.js";

/** Read-only port: the API never generates or schedules derivatives. */
export type DerivedAssetReader = Pick<DerivedAssetRepository, "listByMediaAsset">;
export interface SpriteLayout {
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  timestampsUs: string[];
}
export interface PreviewSelection {
  proxy: DerivedAsset | null;
  poster: DerivedAsset | null;
  sprite: { asset: DerivedAsset; layout: SpriteLayout } | null;
}

/** Newest usable persisted candidate per variant; createdAt DESC, UUID DESC.
 * Historical policies remain valid. No parameter signatures are hardcoded.
 * Membership and source ownership are checked before reading or signing objects.
 */
export class MediaLibrary {
  private readonly details: GetMediaDetails;
  constructor(
    private readonly projects: ProjectRepository,
    private readonly media: MediaAssetRepository,
    private readonly derived: DerivedAssetReader,
    private readonly objects: IObjectStorage,
    private readonly ttl: number,
  ) {
    this.details = new GetMediaDetails(projects, media);
  }

  async list(actor: UserId, projectId: ProjectId) {
    const loaded = await this.projects.findById(projectId);
    if (!loaded || !loaded.project.isListed() || loaded.project.roleOf(actor) === null)
      throw new ProjectNotFoundError();
    const assets = await this.media.listByProject(projectId);
    return Promise.all(
      [...assets]
        .filter((asset) => asset.projectId === projectId)
        .sort((a, b) => compareOrder(a, b))
        .map(async (asset) => ({ asset, previews: await this.select(asset) })),
    );
  }

  async preview(actor: UserId, projectId: ProjectId, id: MediaAssetId) {
    const asset = await this.details.execute(actor, projectId, id);
    const selection = await this.select(asset);
    const sign = async (candidate: DerivedAsset | null) => {
      if (!candidate?.artifact) return { available: false, url: null };
      try {
        const signed = await this.objects.presignGet(candidate.artifact.storageKey, this.ttl);
        return { available: true, url: signed.url };
      } catch {
        throw new ObjectStorageUnavailable();
      }
    };
    const [proxy, poster, sprite] = await Promise.all([
      sign(selection.proxy),
      sign(selection.poster),
      sign(selection.sprite?.asset ?? null),
    ]);
    return {
      expiresInSeconds: this.ttl,
      proxy,
      poster,
      sprite: { ...sprite, layout: selection.sprite?.layout ?? null },
    };
  }

  private async select(source: MediaAsset): Promise<PreviewSelection> {
    const selected: PreviewSelection = { proxy: null, poster: null, sprite: null };
    if (
      source.kind !== "video" ||
      source.inspectionStatus !== "completed" ||
      source.validation.status !== "validated"
    )
      return selected;
    const candidates = [...(await this.derived.listByMediaAsset(source.id))].sort((a, b) =>
      compareOrder(b, a),
    );
    for (const asset of candidates) {
      const artifact = asset.artifact;
      // Never authorize from metadata alone, even when an adapter returns a bad association.
      if (asset.mediaAssetId !== source.id || artifact?.projectId !== source.projectId) continue;
      const variant = artifact.metadata["variant"];
      if (variant === "proxy" && asset.kind === "proxy" && selected.proxy === null)
        selected.proxy = asset;
      if (variant === "poster" && asset.kind === "thumbnail" && selected.poster === null)
        selected.poster = asset;
      if (variant === "sprite" && asset.kind === "thumbnail" && selected.sprite === null) {
        const layout = spriteLayout(artifact.metadata["parameters"], source.duration);
        if (layout) selected.sprite = { asset, layout };
      }
    }
    return selected;
  }
}

function compareOrder(a: { createdAt: bigint; id: string }, b: { createdAt: bigint; id: string }) {
  return a.createdAt === b.createdAt
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.createdAt < b.createdAt
      ? -1
      : 1;
}

/** Whitelist geometry and integer timestamps only; no arbitrary metadata leaves the API. */
export function spriteLayout(value: unknown, duration: bigint | null): SpriteLayout | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  const { tileWidth, tileHeight, columns, rows, timestampsUs } = p;
  if (
    tileWidth !== 160 ||
    tileHeight !== 90 ||
    typeof columns !== "number" ||
    !Number.isInteger(columns) ||
    columns < 1 ||
    columns > 5 ||
    typeof rows !== "number" ||
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 20 ||
    !Array.isArray(timestampsUs) ||
    timestampsUs.length < 1 ||
    timestampsUs.length > 20 ||
    timestampsUs.length > columns * rows ||
    rows !== Math.ceil(timestampsUs.length / columns)
  )
    return null;
  const normalized: string[] = [];
  for (const value of timestampsUs) {
    const text =
      typeof value === "string"
        ? value
        : typeof value === "number" && Number.isSafeInteger(value)
          ? String(value)
          : "";
    if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
    const at = BigInt(text);
    if (
      duration === null ||
      at >= duration ||
      (normalized.length > 0 && at <= BigInt(normalized[normalized.length - 1]!))
    )
      return null;
    normalized.push(text);
  }
  return { tileWidth, tileHeight, columns, rows, timestampsUs: normalized };
}
