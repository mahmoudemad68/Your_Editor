export interface EditorTimeline {
  timeline: {
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
