import { proxyAuth } from "../../../composition/auth-proxy";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return proxyAuth(request, "login");
}
