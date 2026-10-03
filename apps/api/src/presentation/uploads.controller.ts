import { BadRequestException, Body, Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { DomainError, projectId, type ProjectId } from "@editagent/domain";
import { BeginMediaUpload, CompleteMediaUpload } from "../application/uploads.js";
import { ApiRequestLog } from "./api-request-log.js";
import { requireActor } from "./actor.js";
import {
  BeginUploadResponseDto,
  MediaAssetResponseDto,
  toBeginUploadResponse,
  toMediaAssetResponse,
  UploadDeclarationBody,
} from "./upload.dto.js";

@ApiTags("uploads")
@Controller("projects/:projectId/uploads")
export class UploadsController {
  constructor(
    private readonly beginMediaUpload: BeginMediaUpload,
    private readonly completeMediaUpload: CompleteMediaUpload,
    private readonly requestLog: ApiRequestLog,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      "Begin a direct media upload. The browser PUTs bytes to object storage. A 403 or 412 from that PUT comes from object storage, not this API.",
  })
  @ApiCreatedResponse({ type: BeginUploadResponseDto })
  @ApiBadRequestResponse({
    description: "The filename, MIME type, size, or SHA-256 is not allowed.",
  })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  @ApiForbiddenResponse({ description: "Only an Owner or Editor can upload media." })
  @ApiNotFoundResponse({ description: "The Project is not visible to the caller." })
  async begin(
    @Param("projectId") rawProjectId: string,
    @Body() body: UploadDeclarationBody,
    @Req() request: object,
  ): Promise<BeginUploadResponseDto> {
    const result = await this.beginMediaUpload.execute(
      requireActor(request),
      parseProjectRouteId(rawProjectId),
      body,
    );
    return toBeginUploadResponse(result);
  }

  @Post("complete")
  @HttpCode(201)
  @ApiOperation({ summary: "Verify the stored object and record a MediaAsset." })
  @ApiCreatedResponse({ type: MediaAssetResponseDto })
  @ApiBadRequestResponse({ description: "The declared upload is not allowed." })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  @ApiForbiddenResponse({ description: "Only an Owner or Editor can upload media." })
  @ApiNotFoundResponse({ description: "The Project is not visible to the caller." })
  @ApiConflictResponse({
    description: "The stored object is missing, mismatched, or already recorded.",
  })
  @ApiResponse({ status: 502, description: "Object storage is unavailable." })
  async complete(
    @Param("projectId") rawProjectId: string,
    @Body() body: UploadDeclarationBody,
    @Req() request: object,
  ): Promise<MediaAssetResponseDto> {
    const asset = await this.completeMediaUpload.execute(
      requireActor(request),
      parseProjectRouteId(rawProjectId),
      body,
    );
    this.requestLog.jobAccepted("media.inspect", asset.id);
    return toMediaAssetResponse(asset);
  }
}

function parseProjectRouteId(value: string): ProjectId {
  try {
    return projectId(value);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new BadRequestException("projectId must be a UUIDv7.");
    }
    throw error;
  }
}
