export interface EditorTimeline {
  timeline: {
    captionsV1?: CaptionTrack[];
    id: string;
    projectId: string;
    composition: {
      width: number;
      height: number;
      durationUs: string;
      frameRate: { numerator: string; denominator: string };
    };
    tracks: {
      id: string;
      clips: {
        id: string;
        sourceId: string | null;
        inPoint: string;
        outPoint: string;
        timelineStartUs: string;
      }[];
    }[];
  };
  stateSha256: string;
}
export interface CaptionStyle {
  color: string;
  background: string;
  highlight: string;
  outline: string;
  outlinePx: number;
  shadowPx: number;
  font: "DejaVu Sans";
  fontSize: number;
  direction: "auto" | "ltr" | "rtl";
  preset: "vertical" | "square" | "landscape";
  marginPermille: number;
}
export interface CaptionTrack {
  id: string;
  assetId: string;
  sourceSha256: string;
  style: CaptionStyle;
  evidence: { kind: "media-analysis" | "human-timed"; documentSha256: string; version: string };
  blocks: {
    startUs: string;
    endUs: string;
    lines: { text: string; startUs: string; endUs: string; confidence: number | null }[][];
  }[];
}
export interface EditorRender {
  jobId: string;
  status: "Queued" | "Running" | "Retrying" | "Completed" | "Failed" | "Cancelled";
  attempt: number;
  updatedAt: string;
}
export interface EditorDownload {
  previewUrl: string;
  downloadUrl: string;
  expiresInSeconds: number;
}
