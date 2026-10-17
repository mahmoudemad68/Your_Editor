/** Same production Dockerfile/runtime, immutable tiny CPU model, no skipped services. */
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
const root = path.resolve(import.meta.dirname, "../..");
const modelIndex = process.argv.indexOf("--model");
const model = modelIndex < 0 ? "tiny" : process.argv[modelIndex + 1];
const buildOnly = process.argv.includes("--build-only");
if (!["tiny", "small"].includes(model) || (model === "small" && !buildOnly))
  throw new Error("Select tiny for queue verification, or --build-only --model small");
async function run(args, env = process.env) {
  const child = spawn(args[0], args.slice(1), { cwd: root, env, stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`ASR container verification exited ${code}`);
}
const args = [
  "docker",
  "build",
  "-f",
  "workers/ai-worker/Dockerfile",
  "--build-arg",
  `ASR_MODEL=${model}`,
  "-t",
  model === "tiny" ? "editagent-ai-asr:test" : "editagent-ai-asr:small-test",
];
if (process.env.CODEX_PROXY_CERT) {
  args.push("--secret", "id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt");
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"])
    if (process.env[name]) args.push("--build-arg", name);
  const host = new URL(process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY).hostname;
  const { address } = await lookup(host, { family: 4 });
  args.push("--add-host", `${host}:${address}`);
}
args.push(".");
await run(args);
if (!buildOnly)
  await run(
    [process.execPath, "--test", "tests/integration/media-analysis-orchestration.test.mjs"],
    {
      ...process.env,
      EDITAGENT_TEST_ASR_CONTAINER: "1",
    },
  );
