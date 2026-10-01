import { BadRequestException, Controller, Get, Param, Req } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import {
  DomainError,
  mediaAssetId,
  type MediaAssetId,
  projectId,
  type ProjectId,
} from "@editagent/domain";
import { GetMediaDetails } from "../application/media-details.js";
import { requireActor } from "./actor.js";
import { MediaDetailsResponseDto, toMediaDetailsResponse } from "./media.dto.js";

@ApiTags("media")
@Controller("projects/:projectId/media")
export class MediaController {
  constructor(private readonly getMediaDetails: GetMediaDetails) {}

  @Get(":mediaAssetId")
  @ApiOperation({
    summary: "Read persisted technical metadata. This request does not run FFprobe.",
  })
  @ApiOkResponse({ type: MediaDetailsResponseDto })
  @ApiBadRequestResponse({ description: "The Project id or MediaAsset id is not a UUIDv7." })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  @ApiNotFoundResponse({ description: "The MediaAsset is not visible to the caller." })
  async show(
    @Param("projectId") rawProjectId: string,
    @Param("mediaAssetId") rawMediaAssetId: string,
    @Req() request: object,
  ): Promise<MediaDetailsResponseDto> {
    const asset = await this.getMediaDetails.execute(
      requireActor(request),
      parseProjectRouteId(rawProjectId),
      parseMediaAssetId(rawMediaAssetId),
    );
    return toMediaDetailsResponse(asset);
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

function parseMediaAssetId(value: string): MediaAssetId {
  try {
    return mediaAssetId(value);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new BadRequestException("mediaAssetId must be a UUIDv7.");
    }
    throw error;
  }
}
