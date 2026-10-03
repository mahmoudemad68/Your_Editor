import {
  completeUpload,
  correlationIdFromRequest,
} from "../../../../../../composition/project-actions";
import { projectApiResponse } from "../../../../../../composition/project-response";
import { readUploadDeclaration } from "../../../../../../composition/upload-declaration";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const declaration = readUploadDeclaration(await request.json().catch(() => null));
  if (declaration === null) {
    return projectApiResponse({
      ok: false,
      status: 400,
      message: "The upload declaration is not valid.",
    });
  }
  return projectApiResponse(
    await completeUpload(projectId, declaration, correlationIdFromRequest(request)),
  );
}
