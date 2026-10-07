import { proxyInspectionJob } from "../../../../../../../../composition/job-proxy";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string; mediaAssetId: string }> },
) {
  const { projectId, mediaAssetId } = await context.params;
  return proxyInspectionJob(request, projectId, mediaAssetId, true);
}
