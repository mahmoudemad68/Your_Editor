/** Rendering ports contain no browser, queue, SQL or object-storage SDK types. */
import type { TimelineSnapshot, SourceSnapshot } from "@editagent/domain";
export interface FixtureInput {
  readonly schemaVersion: 1;
  readonly renderVersion: string;
  readonly compositionId: "FixtureV1";
  readonly width: number;
  readonly height: number;
  readonly frameRate: { numerator: number; denominator: number };
  readonly durationInFrames: number;
  readonly props: { title: string; background: string };
  readonly correlationId: string;
}
export interface RenderProgress {
  readonly renderedFrames: number;
  readonly encodedFrames: number;
  readonly totalFrames: number;
}
export interface RenderArtifact {
  readonly objectKey: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly renderVersion: string;
  readonly inputSha256: string;
}
export interface IRenderStrategy {
  discard(artifact: RenderArtifact): Promise<void>;
  render(
    input: RenderInput,
    projectId: string,
    jobId: string,
    signal: AbortSignal,
    progress: (value: RenderProgress) => void,
  ): Promise<RenderArtifact>;
}

export type ComponentBinding =
  | { readonly componentId: string; readonly type: "solid-v1"; readonly props: { color: string } }
  | {
      readonly componentId: string;
      readonly type: "title-v1";
      readonly props: { color: string; text: string; background: string; fontSize: number };
    };
export interface TimelineInput {
  readonly schemaVersion: 1;
  readonly renderVersion: string;
  readonly compositionId: "TimelineV1";
  readonly correlationId: string;
  readonly props: {
    timeline: TimelineSnapshot;
    background: string;
    captionStyle: {
      color: string;
      background: string;
      fontSize: number;
      direction: "auto" | "ltr" | "rtl";
    };
    components: ComponentBinding[];
  };
}
export type RenderInput = FixtureInput | TimelineInput;
/** Private, verified staging metadata. Never accepted from a public render payload. */
export interface VerifiedAsset {
  readonly sourceId: string;
  readonly kind: SourceSnapshot["kind"];
  readonly durationUs: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly name: string;
}
export interface ResolvedAsset extends VerifiedAsset {
  readonly objectKey: string;
}
export interface IRenderAssetResolver {
  resolve(
    projectId: string,
    sources: readonly SourceSnapshot[],
    signal: AbortSignal,
  ): Promise<ResolvedAsset[]>;
}
