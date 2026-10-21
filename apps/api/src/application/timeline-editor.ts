import {
  Clip,
  DomainError,
  Timeline,
  Track,
  applyCommand,
  frameRate,
  frameTime,
  type EditCommand,
  type MediaAssetId,
  type ProjectId,
  type ProjectRepository,
  type UserId,
} from "@editagent/domain";
import type { Clock } from "./clock.js";
import { GetMediaDetails } from "./media-details.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";

export interface StoredTimeline {
  readonly timeline: Timeline;
  readonly stateSha256: string;
}
export interface TimelineStore {
  load(project: ProjectId, id: string): Promise<StoredTimeline>;
  /** Atomically fence the expected snapshot and current Owner/Editor membership. */
  save(actor: UserId, timeline: Timeline, expectedSha256: string | null): Promise<string>;
}
export interface TimelineProposals {
  propose(
    actor: UserId,
    project: ProjectId,
    timeline: string,
    operation: "trim-video" | "split-video",
    input: Readonly<Record<string, string>>,
  ): Promise<{ basisSha256: string; commands: readonly EditCommand[] }>;
}
export class TimelineConflict extends Error {
  constructor() {
    super("The timeline changed. Reload it before applying this edit.");
  }
}

/** User-directed edits reuse the canonical Timeline and the audited Tool SDK proposals. */
export class TimelineEditor {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly details: GetMediaDetails,
    private readonly store: TimelineStore,
    private readonly tools: TimelineProposals,
    private readonly clock: Clock,
    private readonly newId: () => string,
  ) {}

  private async access(actor: UserId, project: ProjectId, write: boolean) {
    const loaded = await this.projects.findById(project);
    const role = loaded?.project.roleOf(actor);
    if (!loaded?.project.isListed() || !role) throw new ProjectNotFoundError();
    if (write && role !== "owner" && role !== "editor")
      throw new ProjectForbiddenError("Only an Owner or Editor can edit a timeline.");
  }

  async read(actor: UserId, project: ProjectId, id: string) {
    await this.access(actor, project, false);
    const stored = await this.store.load(project, id);
    await this.access(actor, project, false);
    return this.response(stored.timeline, stored.stateSha256);
  }

  async create(actor: UserId, project: ProjectId, media: MediaAssetId) {
    await this.access(actor, project, true);
    const asset = await this.details.execute(actor, project, media);
    if (
      asset.kind !== "video" ||
      asset.validation.status !== "validated" ||
      asset.inspectionStatus !== "completed" ||
      !asset.duration ||
      !asset.displayWidth ||
      !asset.displayHeight ||
      !asset.frameRateNumerator ||
      !asset.frameRateDenominator
    )
      throw new DomainError("Wait for successful video inspection before editing.");
    const rate = frameRate(asset.frameRateNumerator, asset.frameRateDenominator);
    if (rate.numerator < rate.denominator || rate.numerator > 60n * rate.denominator)
      throw new DomainError("This source frame rate is not supported by the editor.");
    const frames = (asset.duration * rate.numerator) / (1_000_000n * rate.denominator);
    const durationUs = frameTime(frames, rate);
    if (!durationUs) throw new DomainError("The video must contain a complete frame.");
    const id = this.newId(),
      track = this.newId(),
      clip = this.newId();
    const timeline = new Timeline(id, project, this.clock.now(), {
      composition: {
        width: Math.max(2, asset.displayWidth - (asset.displayWidth % 2)),
        height: Math.max(2, asset.displayHeight - (asset.displayHeight % 2)),
        frameRate: rate,
        durationUs,
      },
      sources: [{ id: asset.id, kind: "video", durationUs: asset.duration }],
      tracks: [
        new Track(track, id, "video", [
          new Clip(clip, track, 0n, durationUs, {
            sourceId: asset.id,
          }),
        ]),
      ],
    });
    const hash = await this.store.save(actor, timeline, null);
    return this.response(timeline, hash);
  }

  async edit(
    actor: UserId,
    project: ProjectId,
    id: string,
    expectedSha256: string,
    operation: "trim-video" | "split-video",
    input: Readonly<Record<string, string>>,
  ) {
    await this.access(actor, project, true);
    const stored = await this.store.load(project, id);
    if (stored.stateSha256 !== expectedSha256) throw new TimelineConflict();
    let proposal: Awaited<ReturnType<TimelineProposals["propose"]>>;
    try {
      proposal = await this.tools.propose(actor, project, id, operation, input);
    } catch (error) {
      if (error instanceof DomainError) {
        // The SDK loads its own current snapshot. A concurrent edit can make
        // previously valid bounds invalid before it returns a proposal. Keep
        // genuine validation errors, but classify an advanced basis as a
        // conflict without retrying or applying the stale request.
        await this.access(actor, project, true);
        if ((await this.store.load(project, id)).stateSha256 !== expectedSha256)
          throw new TimelineConflict();
      }
      throw error;
    }
    if (proposal.basisSha256 !== expectedSha256 || proposal.commands.length !== 1)
      throw new TimelineConflict();
    const command = proposal.commands[0]!;
    if (
      command.timelineId !== id ||
      command.type !== (operation === "trim-video" ? "TrimClip" : "SplitClip")
    )
      throw new DomainError("The editing proposal does not match the requested operation.");
    const next = applyCommand(stored.timeline, command).timeline;
    const hash = await this.store.save(actor, next, expectedSha256);
    return this.response(next, hash);
  }

  private response(timeline: Timeline, stateSha256: string) {
    return { timeline: timeline.toSnapshot(), stateSha256 };
  }
}
