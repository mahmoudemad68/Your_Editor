import { proxyAuth } from "../../../composition/auth-proxy";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return proxyAuth(request, "me");
}
