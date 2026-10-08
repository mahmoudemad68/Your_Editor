import { getMediaPreview } from "../../../../../../../composition/project-actions";
import { projectApiResponse } from "../../../../../../../composition/project-response";

export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string; mediaAssetId: string }> },
) {
  const { projectId, mediaAssetId } = await context.params;
  return projectApiResponse(await getMediaPreview(projectId, mediaAssetId, request));
}
