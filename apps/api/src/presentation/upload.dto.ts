import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsString, Matches, Max, MaxLength, Min } from "class-validator";
import { type MediaAsset } from "@editagent/domain";

/** 4 GiB, inclusive. */
const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024;

export class UploadDeclarationBody {
  @ApiProperty({ example: "lecture.mp4" })
  @IsString()
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ example: "video/mp4" })
  @IsString()
  mimeType!: string;

  @ApiProperty({ example: 1234, maximum: MAX_MEDIA_BYTES })
  @IsInt()
  @Min(1)
  @Max(MAX_MEDIA_BYTES)
  byteSize!: number;

  @ApiProperty({ example: "ab".repeat(32) })
  @Matches(/^[0-9a-f]{64}$/)
  sha256!: string;
}

export class BeginUploadResponseDto {
  @ApiProperty()
  uploadUrl!: string;

  @ApiProperty()
  storageKey!: string;

  @ApiProperty({ description: "Unix epoch milliseconds as a decimal string." })
  expiresAt!: string;

  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
  })
  requiredHeaders!: Readonly<Record<string, string>>;
}

export class MediaAssetResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid" })
  projectId!: string;

  @ApiProperty({ enum: ["video", "audio", "image"] })
  kind!: string;

  @ApiProperty()
  displayFilename!: string;

  @ApiProperty()
  mimeType!: string;

  @ApiProperty({ description: "Object size in bytes, as a decimal string." })
  byteSize!: string;

  @ApiProperty({ description: "Unix epoch milliseconds as a decimal string." })
  createdAt!: string;
}

export function toBeginUploadResponse(result: {
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly expiresAt: bigint;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}): BeginUploadResponseDto {
  return {
    uploadUrl: result.uploadUrl,
    storageKey: result.storageKey,
    expiresAt: result.expiresAt.toString(),
    requiredHeaders: result.requiredHeaders,
  };
}

export function toMediaAssetResponse(asset: MediaAsset): MediaAssetResponseDto {
  return {
    id: asset.id,
    projectId: asset.projectId,
    kind: asset.kind,
    displayFilename: asset.displayFilename ?? "",
    mimeType: asset.mimeType ?? "",
    byteSize: (asset.byteSize ?? 0n).toString(),
    createdAt: asset.createdAt.toString(),
  };
}
