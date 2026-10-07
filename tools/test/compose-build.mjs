/** Exact production Dockerfiles on ordinary hosts. Managed-cloud adaptation is
 * build-only proxy/CA trust; no session cert is copied to final image layers. */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
export function command(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code ?? signal}`)),
    );
  });
}
export async function buildProductImages(root, services) {
  const dockerfiles = {
    api: "apps/api/Dockerfile",
    web: "apps/web/Dockerfile",
    "media-worker": "workers/media-worker/Dockerfile",
    postgres: "infra/postgres/Dockerfile",
    redis: "infra/redis/Dockerfile",
  };
  for (const service of services) {
    const args = ["build", "-t", `editagent-${service}:local`];
    let file = dockerfiles[service];
    if (process.env.CODEX_PROXY_CERT) {
      const dir = path.join(root, ".local/walking-skeleton-build");
      mkdirSync(dir, { recursive: true });
      const source = readFileSync(path.join(root, file), "utf8");
      const batched = source
        .replace(/(FROM base AS deps\n)([\s\S]*?)(?=RUN )/, (_m, head) => head + "COPY . .\n")
        .replace(
          /(FROM deps AS build\n)([\s\S]*?)(?=FROM )/,
          (_m, head, body) => head + body.replace(/^COPY (?!.*--from=).*\n/gm, ""),
        );
      const adapted = batched.replace(
        /^RUN /gm,
        "RUN --mount=type=secret,id=proxy_ca,required=true export NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca SSL_CERT_FILE=/run/secrets/proxy_ca CURL_CA_BUNDLE=/run/secrets/proxy_ca GIT_SSL_CAINFO=/run/secrets/proxy_ca; ",
      );
      file = path.join(dir, `${service}.Dockerfile`);
      writeFileSync(file, adapted);
      args.push("--secret", "id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt");
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"])
        if (process.env[name]) args.push("--build-arg", name);
      const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
      if (proxy) {
        const host = new URL(proxy).hostname;
        const { address } = await lookup(host, { family: 4 });
        args.push("--add-host", `${host}:${address}`);
      }
    }
    await command("docker", [...args, "-f", file, "."], { cwd: root });
  }
}
