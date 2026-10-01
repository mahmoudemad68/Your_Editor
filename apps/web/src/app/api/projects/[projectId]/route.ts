import { deleteProject, renameProject } from "../../../../composition/project-actions";
import { projectApiResponse } from "../../../../composition/project-response";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;
  const body: unknown = await request.json().catch(() => null);
  const name =
    typeof body === "object" && body !== null && "name" in body && typeof body.name === "string"
      ? body.name
      : "";
  return projectApiResponse(await renameProject(projectId, name));
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await context.params;
  return projectApiResponse(await deleteProject(projectId));
}
