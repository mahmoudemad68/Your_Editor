import { NextResponse } from "next/server";
import { createProject, listProjects } from "../../../composition/project-actions";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await listProjects());
}

export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const name =
    typeof body === "object" && body !== null && "name" in body && typeof body.name === "string"
      ? body.name
      : "";
  return NextResponse.json(await createProject(name));
}
