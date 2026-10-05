import { Body, Controller, Delete, Get, Param, Post, Req, HttpCode, Header } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiProperty,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiResponse,
} from "@nestjs/swagger";
import { IsString, MaxLength, MinLength } from "class-validator";
import { projectId } from "@editagent/domain";
import { MultipartUploads, type MultipartState } from "../application/multipart-uploads.js";
import { requireActor } from "./actor.js";
import { requestCorrelationId } from "./correlation.js";
import {
  UploadDeclarationBody,
  MediaAssetResponseDto,
  toMediaAssetResponse,
} from "./upload.dto.js";

export class UploadPartResponseDto {
  @ApiProperty() partNumber!: number;
  @ApiProperty() etag!: string;
  @ApiProperty() byteSize!: number;
  @ApiProperty({ type: String, nullable: true }) checksum!: string | null;
}
export class MultipartStateDto extends UploadDeclarationBody {
  @ApiProperty({ format: "uuid" }) uploadSessionId!: string;
  @ApiProperty() partSize!: number;
  @ApiProperty({ enum: ["active", "completing", "completed", "aborted", "expired", "failed"] })
  status!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ type: String, nullable: true }) mediaAssetId!: string | null;
  @ApiProperty({ type: [UploadPartResponseDto] }) parts!: UploadPartResponseDto[];
}
export class PartUrlDto {
  @ApiProperty() url!: string;
  @ApiProperty({ type: "object", additionalProperties: { type: "string" } })
  requiredHeaders!: Record<string, string>;
  @ApiProperty() expiresAt!: string;
}
export class PartCompleteBody {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) etag!: string;
}
function state(result: MultipartState): MultipartStateDto {
  const s = result.session;
  return {
    uploadSessionId: s.id,
    filename: s.filename,
    mimeType: s.mimeType,
    byteSize: s.byteSize,
    sha256: s.sha256,
    partSize: s.partSize,
    status: s.status,
    expiresAt: s.expiresAt.toString(),
    mediaAssetId: s.mediaAssetId,
    parts: result.parts.map((p) => ({
      partNumber: p.partNumber,
      etag: p.etag,
      byteSize: p.byteSize,
      checksum: p.checksum,
    })),
  };
}
@ApiTags("uploads")
@ApiBadRequestResponse({ description: "Invalid declaration, route, or part number." })
@ApiUnauthorizedResponse({ description: "Sign in is required." })
@ApiForbiddenResponse({
  description: "Only an Owner/Editor creator may upload; cookie mutations require explicit CSRF.",
})
@ApiNotFoundResponse({ description: "The project/session is not visible to the caller." })
@ApiConflictResponse({
  description: "The session, part, or final object cannot be completed as declared.",
})
@ApiResponse({ status: 502, description: "Object storage is unavailable." })
@Controller("projects/:projectId/uploads/multipart")
export class MultipartController {
  constructor(private readonly uploads: MultipartUploads) {}
  @Post()
  @Header("Cache-Control", "private, no-store")
  @HttpCode(201)
  @ApiOperation({ summary: "Start or recover a creator-owned resumable upload." })
  @ApiCreatedResponse({ type: MultipartStateDto })
  async start(
    @Param("projectId") project: string,
    @Body() body: UploadDeclarationBody,
    @Req() req: object,
  ) {
    return state(await this.uploads.start(requireActor(req), projectId(project), body));
  }
  @Get(":sessionId")
  @Header("Cache-Control", "private, no-store")
  @ApiOkResponse({ type: MultipartStateDto })
  async get(
    @Param("projectId") project: string,
    @Param("sessionId") id: string,
    @Req() req: object,
  ) {
    return state(await this.uploads.get(requireActor(req), projectId(project), id));
  }
  @Post(":sessionId/parts/:partNumber")
  @Header("Cache-Control", "private, no-store")
  @HttpCode(200)
  @ApiOkResponse({ type: PartUrlDto })
  async sign(
    @Param("projectId") project: string,
    @Param("sessionId") id: string,
    @Param("partNumber") part: string,
    @Req() req: object,
  ) {
    return this.uploads.signPart(requireActor(req), projectId(project), id, Number(part));
  }
  @Post(":sessionId/parts/:partNumber/complete")
  @Header("Cache-Control", "private, no-store")
  @HttpCode(200)
  @ApiOkResponse({ type: MultipartStateDto })
  async record(
    @Param("projectId") project: string,
    @Param("sessionId") id: string,
    @Param("partNumber") part: string,
    @Body() body: PartCompleteBody,
    @Req() req: object,
  ) {
    return state(
      await this.uploads.recordPart(
        requireActor(req),
        projectId(project),
        id,
        Number(part),
        body.etag,
      ),
    );
  }
  @Post(":sessionId/complete")
  @Header("Cache-Control", "private, no-store")
  @HttpCode(201)
  @ApiCreatedResponse({ type: MediaAssetResponseDto })
  async complete(
    @Param("projectId") project: string,
    @Param("sessionId") id: string,
    @Req() req: object,
  ) {
    return toMediaAssetResponse(
      await this.uploads.complete(
        requireActor(req),
        projectId(project),
        id,
        requestCorrelationId(),
      ),
    );
  }
  @Delete(":sessionId")
  @Header("Cache-Control", "private, no-store")
  @HttpCode(204)
  @ApiNoContentResponse()
  async abort(
    @Param("projectId") project: string,
    @Param("sessionId") id: string,
    @Req() req: object,
  ) {
    await this.uploads.abort(requireActor(req), projectId(project), id);
  }
}
