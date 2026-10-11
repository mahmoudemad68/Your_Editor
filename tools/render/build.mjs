import { URL } from "node:url";
import { command } from "../test/compose-build.mjs";
import { lookup } from "node:dns/promises";
import process from "node:process";
const root = new URL("../../", import.meta.url).pathname;
export async function buildRenderImages() {
  for (const target of ["coordinator", "executor"]) {
    const args = [
      "build",
      "--target",
      target,
      "-f",
      "workers/render-worker/Dockerfile",
      "-t",
      `editagent-render-${target}:test`,
    ];
    if (process.env.CODEX_PROXY_CERT) {
      args.push("--secret", "id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt");
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"])
        if (process.env[key]) args.push("--build-arg", key);
      const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
      if (proxy) {
        const host = new URL(proxy).hostname;
        args.push("--add-host", `${host}:${(await lookup(host, { family: 4 })).address}`);
      }
    }
    if (process.env.EDITAGENT_RENDER_BUILD_STORE)
      args.push("--build-context", `pnpm-store=${process.env.EDITAGENT_RENDER_BUILD_STORE}`);
    if (process.env.EDITAGENT_RENDER_BUILD_MEDIA_TOOLS)
      args.push("--build-context", `media-tools=${process.env.EDITAGENT_RENDER_BUILD_MEDIA_TOOLS}`);
    await command("docker", [...args, "."], { cwd: root });
  }
}
if (process.argv[1] === new URL(import.meta.url).pathname) await buildRenderImages();
