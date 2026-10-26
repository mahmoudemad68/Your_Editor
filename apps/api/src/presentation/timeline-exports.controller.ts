import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import {
  ApiBody,
  ApiProperty,
  ApiTags,
  ApiResponse,
  type ApiResponseSchemaHost,
} from "@nestjs/swagger";
import { renderValidationOpenApiSchema } from "@editagent/schemas";
import { projectId, uuidV7 } from "@editagent/domain";
import { TimelineExports } from "../application/timeline-exports.js";
import { requireActor } from "./actor.js";
import { editingBody, EDITING_HASH, EDITING_REQUEST } from "./editing-body.js";

export class RenderTimelineDto {
  @ApiProperty() stateSha256!: string;
  @ApiProperty() requestId!: string;
}
@ApiTags("editing")
@Controller("projects/:projectId")
export class TimelineExportsController {
  constructor(private readonly exports: TimelineExports) {}
  @Post("timelines/:timelineId/render")
  @ApiBody({ type: RenderTimelineDto })
  start(
    @Param("projectId") project: string,
    @Param("timelineId") id: string,
    @Body() raw: unknown,
    @Req() request: object,
  ) {
    const actor = requireActor(request);
    const body = editingBody(raw, { stateSha256: EDITING_HASH, requestId: EDITING_REQUEST });
    return this.exports.start(
      actor,
      projectId(project),
      uuidV7(id),
      body.stateSha256!,
      body.requestId!,
    );
  }
  @Get("exports/:jobId")
  read(@Param("projectId") project: string, @Param("jobId") id: string, @Req() request: object) {
    return this.exports.read(requireActor(request), projectId(project), uuidV7(id));
  }
  @Post("exports/:jobId/cancel")
  cancel(@Param("projectId") project: string, @Param("jobId") id: string, @Req() request: object) {
    return this.exports.cancel(requireActor(request), projectId(project), uuidV7(id));
  }
  @Get("exports/:jobId/download")
  download(
    @Param("projectId") project: string,
    @Param("jobId") id: string,
    @Req() request: object,
  ) {
    return this.exports.download(requireActor(request), projectId(project), uuidV7(id));
  }
  @Get("exports/:jobId/validation")
  @ApiResponse({
    status: 200,
    schema: renderValidationOpenApiSchema as ApiResponseSchemaHost["schema"],
  })
  validation(
    @Param("projectId") project: string,
    @Param("jobId") id: string,
    @Req() request: object,
  ) {
    return this.exports.validation(requireActor(request), projectId(project), uuidV7(id));
  }
}
