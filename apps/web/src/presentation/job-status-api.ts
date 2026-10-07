import type { InspectionJob, JobStatusApi } from "../job-contract";
import { sessionClient } from "./session-client";
async function request(project: string, media: string, retry: boolean, signal: AbortSignal) {
  const response = await sessionClient.authenticatedFetch(
    `/api/projects/${encodeURIComponent(project)}/media/${encodeURIComponent(media)}/${retry ? "inspection/retry" : "inspection-job"}`,
    { method: retry ? "POST" : "GET", signal },
  );
  if (!response.ok) throw new Error("The inspection request was not completed.");
  return response.json();
}
export const browserJobStatusApi: JobStatusApi = {
  async snapshot(project, media, signal): Promise<InspectionJob | null> {
    return (await request(project, media, false, signal)).job;
  },
  retry: (project, media, signal) => request(project, media, true, signal),
};
