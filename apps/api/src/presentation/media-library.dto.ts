import { ApiProperty } from "@nestjs/swagger";
import type { MediaAsset } from "@editagent/domain";
import type { PreviewSelection } from "../application/media-library.js";
import { MediaDetailsResponseDto, toMediaDetailsResponse } from "./media.dto.js";

export class PreviewAvailabilityDto {
  @ApiProperty() proxy!: boolean;
  @ApiProperty() poster!: boolean;
  @ApiProperty() sprite!: boolean;
}

export class MediaLibraryItemDto {
  @ApiProperty({ format: "uuid" }) id!: string;
  @ApiProperty({ nullable: true, type: String }) displayFilename!: string | null;
  @ApiProperty({ enum: ["video", "audio", "image"] }) kind!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Integer microseconds, decimal string.",
  })
  duration!: string | null;
  @ApiProperty({ enum: ["pending", "completed", "failed"] })
  inspectionStatus!: MediaDetailsResponseDto["inspectionStatus"];
  @ApiProperty({ enum: ["pending", "validated", "rejected"] })
  validationStatus!: MediaDetailsResponseDto["validationStatus"];
  @ApiProperty({ nullable: true, type: String }) rejectionCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) rejectionMessage!: string | null;
  @ApiProperty({ nullable: true, type: String }) inspectionError!: string | null;
  @ApiProperty({ description: "Creation time in integer epoch milliseconds." }) createdAt!: string;
  @ApiProperty({ type: PreviewAvailabilityDto }) previews!: PreviewAvailabilityDto;
}

export class MediaLibraryResponseDto {
  @ApiProperty({ type: [MediaLibraryItemDto] }) media!: MediaLibraryItemDto[];
}

export class PreviewAssetDto {
  @ApiProperty() available!: boolean;
  @ApiProperty({ nullable: true, type: String }) url!: string | null;
}
export class SpriteLayoutDto {
  @ApiProperty() tileWidth!: number;
  @ApiProperty() tileHeight!: number;
  @ApiProperty() columns!: number;
  @ApiProperty() rows!: number;
  @ApiProperty({ type: [String], description: "Sample timestamps in integer microseconds." })
  timestampsUs!: string[];
}
export class SpritePreviewDto extends PreviewAssetDto {
  @ApiProperty({ nullable: true, type: SpriteLayoutDto }) layout!: SpriteLayoutDto | null;
}
export class MediaPreviewResponseDto {
  @ApiProperty() expiresInSeconds!: number;
  @ApiProperty({ type: PreviewAssetDto }) proxy!: PreviewAssetDto;
  @ApiProperty({ type: PreviewAssetDto }) poster!: PreviewAssetDto;
  @ApiProperty({ type: SpritePreviewDto }) sprite!: SpritePreviewDto;
}

export function toLibraryItem(asset: MediaAsset, previews: PreviewSelection): MediaLibraryItemDto {
  const safe = toMediaDetailsResponse(asset);
  return {
    id: safe.id,
    displayFilename: safe.displayFilename,
    kind: safe.kind,
    duration: safe.duration,
    inspectionStatus: safe.inspectionStatus,
    validationStatus: safe.validationStatus,
    rejectionCode: safe.rejectionCode,
    rejectionMessage: safe.rejectionMessage,
    inspectionError: safe.inspectionError,
    createdAt: asset.createdAt.toString(),
    previews: {
      proxy: previews.proxy !== null,
      poster: previews.poster !== null,
      sprite: previews.sprite !== null,
    },
  };
}
