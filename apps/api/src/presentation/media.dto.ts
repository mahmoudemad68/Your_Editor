import { ApiProperty } from "@nestjs/swagger";
import { type MediaAsset, type MediaStreamMetadata } from "@editagent/domain";

export class MediaStreamDto {
  @ApiProperty({ enum: ["video", "audio"] })
  codecType!: "video" | "audio";

  @ApiProperty({ nullable: true, type: String })
  codecName!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  width!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  height!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  sampleRate!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  channels!: number | null;
}

export class MediaDetailsResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty({ format: "uuid" })
  projectId!: string;

  @ApiProperty({ enum: ["video", "audio", "image"] })
  kind!: string;

  @ApiProperty({ nullable: true, type: String })
  displayFilename!: string | null;

  @ApiProperty({ enum: ["pending", "completed", "failed"] })
  inspectionStatus!: "pending" | "completed" | "failed";

  @ApiProperty({
    nullable: true,
    type: String,
    description: "Duration in integer microseconds, as a decimal string.",
  })
  duration!: string | null;

  @ApiProperty({ nullable: true, type: String })
  container!: string | null;

  @ApiProperty({ nullable: true, type: String })
  videoCodec!: string | null;

  @ApiProperty({ nullable: true, type: String })
  audioCodec!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  width!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  height!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  displayWidth!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  displayHeight!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  rotation!: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: "Frame rate numerator as a decimal string.",
  })
  frameRateNumerator!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: "Frame rate denominator as a decimal string.",
  })
  frameRateDenominator!: string | null;

  @ApiProperty({ nullable: true, enum: ["constant", "variable", "unknown"] })
  frameRateMode!: "constant" | "variable" | "unknown" | null;

  @ApiProperty({ nullable: true, type: String })
  colorSpace!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  audioChannels!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  sampleRate!: number | null;

  @ApiProperty({ type: [MediaStreamDto], nullable: true })
  streams!: MediaStreamDto[] | null;

  @ApiProperty({ nullable: true, type: String })
  inspectionError!: string | null;
}

export function toMediaDetailsResponse(asset: MediaAsset): MediaDetailsResponseDto {
  const completed = asset.inspectionStatus === "completed";
  return {
    id: asset.id,
    projectId: asset.projectId,
    kind: asset.kind,
    displayFilename: asset.displayFilename,
    inspectionStatus: asset.inspectionStatus,
    duration: asset.duration === null ? null : asset.duration.toString(),
    container: completed ? asset.container : null,
    videoCodec: completed ? asset.videoCodec : null,
    audioCodec: completed ? asset.audioCodec : null,
    width: completed ? asset.width : null,
    height: completed ? asset.height : null,
    displayWidth: completed ? asset.displayWidth : null,
    displayHeight: completed ? asset.displayHeight : null,
    rotation: completed ? asset.rotation : null,
    frameRateNumerator:
      completed && asset.frameRateNumerator !== null ? asset.frameRateNumerator.toString() : null,
    frameRateDenominator:
      completed && asset.frameRateDenominator !== null
        ? asset.frameRateDenominator.toString()
        : null,
    frameRateMode: completed ? asset.frameRateMode : null,
    colorSpace: completed ? asset.colorSpace : null,
    audioChannels: completed ? asset.audioChannels : null,
    sampleRate: completed ? asset.sampleRate : null,
    streams: completed ? (asset.streams ?? []).map(toStream) : null,
    inspectionError: asset.inspectionStatus === "failed" ? asset.inspectionError : null,
  };
}

function toStream(stream: MediaStreamMetadata): MediaStreamDto {
  return {
    codecType: stream.codecType,
    codecName: stream.codecName,
    width: stream.width,
    height: stream.height,
    sampleRate: stream.sampleRate,
    channels: stream.channels,
  };
}
