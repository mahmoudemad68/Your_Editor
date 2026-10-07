import { BadRequestException, Controller, Get, Param, Post, Req } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { DomainError, mediaAssetId, projectId } from "@editagent/domain";
import { MediaInspectionJobs, type InspectionJobSnapshot } from "../application/inspection-job.js";
import { requireActor } from "./actor.js";
import { requestCorrelationId } from "./correlation.js";
export class InspectionJobDto implements InspectionJobSnapshot {
  @ApiProperty({ format: "uuid" }) jobId!: string;
  @ApiProperty({ enum: ["media.inspect"] }) jobType!: "media.inspect";
  @ApiProperty({ enum: ["Queued", "Running", "Retrying", "Completed", "Failed", "Cancelled"] })
  status!: InspectionJobSnapshot["status"];
  @ApiProperty({ minimum: 0, type: Number }) attempt!: number;
  @ApiProperty({ nullable: true, enum: ["processing_failed", "cancelled"], type: String })
  reason!: InspectionJobSnapshot["reason"];
  @ApiProperty({ description: "Persisted creation time in epoch milliseconds, decimal string." })
  createdAt!: string;
  @ApiProperty({ description: "Persisted update time in epoch milliseconds, decimal string." })
  updatedAt!: string;
  @ApiProperty({
    minimum: 0,
    type: Number,
    description: "Last allocated live event sequence; no replay is implied.",
  })
  sequence!: number;
}
export class InspectionJobResponseDto {
  @ApiProperty({ nullable: true, type: InspectionJobDto }) job!: InspectionJobDto | null;
}
@ApiTags("media")
@ApiUnauthorizedResponse({ description: "Sign in is required." })
@ApiNotFoundResponse({ description: "The media is not visible to the caller." })
@ApiBadRequestResponse({ description: "Identifiers must be UUIDv7." })
@Controller("projects/:projectId/media/:mediaAssetId")
export class InspectionJobController {
  constructor(private readonly jobs: MediaInspectionJobs) {}
  @Get("inspection-job")
  @ApiOperation({
    summary:
      "Read the latest persisted inspection Job, without internal payload or failure details.",
  })
  @ApiOkResponse({ type: InspectionJobResponseDto })
  async show(
    @Param("projectId") project: string,
    @Param("mediaAssetId") media: string,
    @Req() request: object,
  ): Promise<InspectionJobResponseDto> {
    const actor = requireActor(request);
    const ids = parse(project, media);
    return { job: await this.jobs.read(actor, ids.project, ids.media) };
  }
  @Post("inspection/retry")
  @ApiOperation({
    summary:
      "Queue a successor of the latest failed/cancelled inspection. History remains immutable.",
  })
  @ApiCreatedResponse({ type: InspectionJobDto })
  @ApiForbiddenResponse({ description: "Viewer cannot retry." })
  @ApiConflictResponse({ description: "No failed/cancelled inspection is eligible." })
  async retry(
    @Param("projectId") project: string,
    @Param("mediaAssetId") media: string,
    @Req() request: object,
  ): Promise<InspectionJobDto> {
    const actor = requireActor(request);
    const ids = parse(project, media);
    return this.jobs.retry(actor, ids.project, ids.media, requestCorrelationId());
  }
}
function parse(project: string, media: string) {
  try {
    return { project: projectId(project), media: mediaAssetId(media) };
  } catch (error) {
    if (error instanceof DomainError) throw new BadRequestException("Identifiers must be UUIDv7.");
    throw error;
  }
}
