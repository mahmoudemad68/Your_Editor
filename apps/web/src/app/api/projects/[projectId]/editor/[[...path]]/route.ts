import { proxyEditor } from "../../../../../../composition/editor-proxy";
type Context = { params: Promise<{ projectId: string; path?: string[] }> };
export async function GET(request: Request, context: Context) {
  const params = await context.params;
  return proxyEditor(request, params.projectId, params.path ?? []);
}
export const POST = GET;
