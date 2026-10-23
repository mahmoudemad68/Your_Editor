import {
  Post,
  Body,
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  Req,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { jobId, mediaAssetId, projectId } from "@editagent/domain";
import { GetMediaAnalysis } from "../application/media-analysis.js";
import { requireActor } from "./actor.js";

@ApiTags("media")
@Controller()
export class MediaAnalysisController {
  constructor(private readonly analysis: GetMediaAnalysis) {}
  @Post("media/:mediaId/analysis/:analyzer/retry")
  @Header("Cache-Control", "private, no-store")
  async retry(
    @Param("mediaId") asset: string,
    @Param("analyzer") analyzer: string,
    @Body() body: unknown,
    @Req() request: object,
  ) {
    if (
      !["transcript", "audio", "speech"].includes(analyzer) ||
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).join(",") !== "previousJobId" ||
      !Object.hasOwn(body, "previousJobId")
    )
      throw new BadRequestException("Invalid analyzer retry request.");
    const prior = (body as { previousJobId: unknown }).previousJobId;
    if (typeof prior !== "string") throw new BadRequestException("Invalid analyzer retry request.");
    let id: ReturnType<typeof mediaAssetId>;
    try {
      id = mediaAssetId(asset);
      jobId(prior);
    } catch {
      throw new BadRequestException("Invalid analysis identity.");
    }
    return this.analysis.rerun(
      requireActor(request),
      id,
      analyzer as "transcript" | "audio" | "speech",
      prior,
    );
  }
  @Get("media/:mediaId/analysis")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({
    summary: "Read authorized MediaAnalysis using the persisted asset's project identity.",
  })
  getByAsset(@Param("mediaId") asset: string, @Req() request: object) {
    let id: ReturnType<typeof mediaAssetId>;
    try {
      id = mediaAssetId(asset);
    } catch {
      throw new BadRequestException("Invalid media identity.");
    }
    return this.analysis.executeForAsset(requireActor(request), id);
  }
  @Get("projects/:projectId/media/:mediaId/analysis")
  @Header("Cache-Control", "private, no-store")
  @ApiOperation({ summary: "Read versioned MediaAnalysis for an authorized project asset." })
  get(
    @Param("projectId") project: string,
    @Param("mediaId") asset: string,
    @Req() request: object,
  ) {
    let p: ReturnType<typeof projectId>, m: ReturnType<typeof mediaAssetId>;
    try {
      p = projectId(project);
      m = mediaAssetId(asset);
    } catch {
      throw new BadRequestException("Invalid media identity.");
    }
    return this.analysis.execute(requireActor(request), p, m);
  }
}
