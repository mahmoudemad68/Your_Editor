import { Body, Controller, Get, Param, Post, Req } from "@nestjs/common";
import { ApiBody, ApiProperty, ApiTags } from "@nestjs/swagger";
import { mediaAssetId, projectId, uuidV7 } from "@editagent/domain";
import { TimelineEditor } from "../application/timeline-editor.js";
import { requireActor } from "./actor.js";
import { editingBody, EDITING_UUID, EDITING_HASH, EDITING_TIME } from "./editing-body.js";

export class CreateTimelineDto {
  @ApiProperty({ format: "uuid" }) mediaAssetId!: string;
}
class EditBasisDto {
  @ApiProperty() stateSha256!: string;
  @ApiProperty({ format: "uuid" }) clipId!: string;
}
export class TrimTimelineDto extends EditBasisDto {
  @ApiProperty() startUs!: string;
  @ApiProperty() endUs!: string;
}
export class SplitTimelineDto extends EditBasisDto {
  @ApiProperty() atUs!: string;
}

@ApiTags("editing")
@Controller("projects/:projectId/timelines")
export class TimelineEditorController {
  constructor(private readonly editor: TimelineEditor) {}
  @Post()
  @ApiBody({ type: CreateTimelineDto })
  create(@Param("projectId") project: string, @Body() raw: unknown, @Req() request: object) {
    const actor = requireActor(request);
    const body = editingBody(raw, { mediaAssetId: EDITING_UUID });
    return this.editor.create(actor, projectId(project), mediaAssetId(body.mediaAssetId!));
  }
  @Get(":timelineId")
  read(
    @Param("projectId") project: string,
    @Param("timelineId") id: string,
    @Req() request: object,
  ) {
    return this.editor.read(requireActor(request), projectId(project), uuidV7(id));
  }
  @Post(":timelineId/trim")
  @ApiBody({ type: TrimTimelineDto })
  trim(
    @Param("projectId") project: string,
    @Param("timelineId") id: string,
    @Body() raw: unknown,
    @Req() request: object,
  ) {
    const actor = requireActor(request);
    const body = editingBody(raw, {
      stateSha256: EDITING_HASH,
      clipId: EDITING_UUID,
      startUs: EDITING_TIME,
      endUs: EDITING_TIME,
    });
    return this.editor.edit(
      actor,
      projectId(project),
      uuidV7(id),
      body.stateSha256!,
      "trim-video",
      { clipId: body.clipId!, startUs: body.startUs!, endUs: body.endUs! },
    );
  }
  @Post(":timelineId/split")
  @ApiBody({ type: SplitTimelineDto })
  split(
    @Param("projectId") project: string,
    @Param("timelineId") id: string,
    @Body() raw: unknown,
    @Req() request: object,
  ) {
    const actor = requireActor(request);
    const body = editingBody(raw, {
      stateSha256: EDITING_HASH,
      clipId: EDITING_UUID,
      atUs: EDITING_TIME,
    });
    return this.editor.edit(
      actor,
      projectId(project),
      uuidV7(id),
      body.stateSha256!,
      "split-video",
      { clipId: body.clipId!, atUs: body.atUs! },
    );
  }
}
