import { listMedia } from "../../../../../composition/project-actions";
import { projectApiResponse } from "../../../../../composition/project-response";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  return projectApiResponse(await listMedia(projectId, request));
}
