import { Body, Controller, Get, Param, Post, Req, BadRequestException } from "@nestjs/common";
import { ApiBody, ApiProperty, ApiTags } from "@nestjs/swagger";
import { captionStyle, projectId, uuidV7 } from "@editagent/domain";
import { TimelineCaptions } from "../application/timeline-captions.js";
import { requireActor } from "./actor.js";
import { editingBody, EDITING_UUID, EDITING_HASH } from "./editing-body.js";
class CaptionBasisDto {
  @ApiProperty() stateSha256!: string;
  @ApiProperty({ format: "uuid" }) requestId!: string;
  @ApiProperty({ type: Object }) style!: object;
}
export class AddTimedCaptionDto extends CaptionBasisDto {
  @ApiProperty({ format: "uuid" }) assetId!: string;
  @ApiProperty() sourceSha256!: string;
  @ApiProperty() analysisSha256!: string;
}
export class UpdateCaptionStyleDto extends CaptionBasisDto {}
export class UndoCaptionDto {
  @ApiProperty() stateSha256!: string;
}
function body(raw: unknown, add: boolean) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new BadRequestException("Invalid caption parameters.");
  const { style, ...basis } = raw as Record<string, unknown>;
  const fields = add
    ? {
        stateSha256: EDITING_HASH,
        requestId: EDITING_UUID,
        assetId: EDITING_UUID,
        sourceSha256: EDITING_HASH,
        analysisSha256: EDITING_HASH,
      }
    : { stateSha256: EDITING_HASH, requestId: EDITING_UUID };
  return { basis: editingBody(basis, fields), style: captionStyle(style) };
}
@ApiTags("editing")
@Controller("projects/:projectId/timelines/:timelineId/captions")
export class TimelineCaptionsController {
  constructor(private readonly captions: TimelineCaptions) {}
  @Get("sources/:assetId")
  source(
    @Param("projectId") p: string,
    @Param("timelineId") t: string,
    @Param("assetId") a: string,
    @Req() r: object,
  ) {
    return this.captions.source(requireActor(r), projectId(p), uuidV7(t), uuidV7(a));
  }
  @Get("history")
  history(@Param("projectId") p: string, @Param("timelineId") t: string, @Req() r: object) {
    return this.captions.history(requireActor(r), projectId(p), uuidV7(t));
  }
  @Post()
  @ApiBody({ type: AddTimedCaptionDto })
  add(
    @Param("projectId") p: string,
    @Param("timelineId") t: string,
    @Body() raw: unknown,
    @Req() r: object,
  ) {
    const actor = requireActor(r),
      b = body(raw, true);
    return this.captions.execute(actor, projectId(p), uuidV7(t), {
      stateSha256: b.basis.stateSha256!,
      requestId: b.basis.requestId!,
      operation: "add-caption",
      input: {
        assetId: b.basis.assetId,
        sourceSha256: b.basis.sourceSha256,
        analysisSha256: b.basis.analysisSha256,
        style: b.style,
      },
    });
  }
  @Post(":captionId/style")
  @ApiBody({ type: UpdateCaptionStyleDto })
  style(
    @Param("projectId") p: string,
    @Param("timelineId") t: string,
    @Param("captionId") c: string,
    @Body() raw: unknown,
    @Req() r: object,
  ) {
    const actor = requireActor(r),
      b = body(raw, false);
    return this.captions.execute(actor, projectId(p), uuidV7(t), {
      stateSha256: b.basis.stateSha256!,
      requestId: b.basis.requestId!,
      operation: "update-caption-style",
      input: { captionId: uuidV7(c), style: b.style },
    });
  }
  @Post(":commandId/undo")
  @ApiBody({ type: UndoCaptionDto })
  undo(
    @Param("projectId") p: string,
    @Param("timelineId") t: string,
    @Param("commandId") c: string,
    @Body() raw: unknown,
    @Req() r: object,
  ) {
    const actor = requireActor(r),
      b = editingBody(raw, { stateSha256: EDITING_HASH });
    return this.captions.undo(actor, projectId(p), uuidV7(t), uuidV7(c), b.stateSha256!);
  }
}
