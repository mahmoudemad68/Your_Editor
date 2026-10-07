import { proxyInspectionJob } from "../../../../../../../composition/job-proxy";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; mediaAssetId: string }> },
) {
  const { projectId, mediaAssetId } = await context.params;
  return proxyInspectionJob(request, projectId, mediaAssetId, false);
}
