import { createProject, listProjects } from "../../../composition/project-actions";
import { projectApiResponse } from "../../../composition/project-response";

export const dynamic = "force-dynamic";

export async function GET() {
  return projectApiResponse(await listProjects());
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const name =
    typeof body === "object" && body !== null && "name" in body && typeof body.name === "string"
      ? body.name
      : "";
  return projectApiResponse(await createProject(name));
}
