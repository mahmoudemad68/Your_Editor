/** No remote operation is permitted until independent exact-source admission. */
import process from "node:process";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  lstat,
  readdir,
  realpath,
  rm,
  statfs,
} from "node:fs/promises";

export const OFFICIAL = Object.freeze({
  upload: Object.freeze({
    repo: "upload-artifact",
    commit: "cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    entry: "dist/upload/index.js",
    bytes: 4452820,
    sha256: "c0e58b240360573e6d6c82ea1bb22deff4f85883e00211a52bd27822c3a22617",
    package_sha256: "6006e753abafb2519b884767c8a67abff6c0c6636e6c83eae1081501fbcda56e",
    action_sha256: "c5979822866a72362e609844b6ebe77d4b7e759af68cc1c2c425dcf51481fab4",
  }),
  download: Object.freeze({
    repo: "download-artifact",
    commit: "9000827ccba6bdab643e8b6fd33ac0654aef8333",
    entry: "dist/index.js",
    bytes: 4432922,
    sha256: "7834b909df0fd656f5ac1c4c4ab4ee3b5e2673e4f4f763549d8abbca16bc5bbe",
    package_sha256: "3cb12ab5f8f76d115f8c85469a155d56b79610ddd5faa945697c16098ec83a6e",
    action_sha256: "e98559b7a31ba31be4709f20d22102dc2737fa630f69a339eb89981151e505fe",
  }),
});
export const BOUNDS = Object.freeze({
  address_space: 8 * 1024 ** 3,
  cpu: 120,
  wall: 180,
  scratch: 384 * 1024 ** 2,
  source_zip: 125829120 + 8 * 1024 ** 2 + 65536,
});
const SOURCE = [
  "image.tar.xz",
  "candidate-manifest.json",
  "verification.json",
  "go-version-m.txt",
  "full-trivy.json",
  "sbom.spdx.json",
  "scanner-versions.json",
];
export const MEMBERS = Object.freeze({
  source: SOURCE,
  walking: [...SOURCE, "admission.json"],
  seal: ["seal.json"],
  ci: ["admission.json"],
  outcome: ["admission-outcome.json"],
});
export function validatePinnedBytes(operation, member, bytes) {
  const pin = OFFICIAL[operation];
  requireThat(pin, "OFFICIAL_ACTION_UNKNOWN");
  const expected =
    member === "entry"
      ? pin.sha256
      : member === "package"
        ? pin.package_sha256
        : member === "action"
          ? pin.action_sha256
          : null;
  const cap = member === "entry" ? pin.bytes : member === "package" ? 65536 : 16384;
  requireThat(
    expected &&
      Buffer.isBuffer(bytes) &&
      bytes.length <= cap &&
      hash(bytes) === expected &&
      (member !== "entry" || bytes.length === cap),
    "OFFICIAL_ACTION_HASH_MISMATCH",
  );
  return true;
}
const fail = (code) => {
  throw new Error(code);
};
const requireThat = (ok, code) => {
  if (!ok) fail(code);
};
const hash = (b) => createHash("sha256").update(b).digest("hex");
const integer = (s) => {
  requireThat(/^[1-9][0-9]{0,15}$/.test(String(s)), "ARTIFACT_INTEGER_INVALID");
  const n = Number(s);
  requireThat(Number.isSafeInteger(n), "ARTIFACT_INTEGER_INVALID");
  return n;
};
export function artifactPlan(input, env) {
  requireThat(
    Object.keys(input).every((k) =>
      ["operation", "role", "bundle", "artifact-id", "artifact-digest", "artifact-bytes"].includes(
        k,
      ),
    ),
    "ADAPTER_INPUT_REJECTED",
  );
  requireThat(
    ["upload", "download"].includes(input.operation) && Object.hasOwn(MEMBERS, input.role),
    "ADAPTER_ROLE_REJECTED",
  );
  requireThat(
    env.GITHUB_REPOSITORY === "mahmoudemad68/Your_Editor" &&
      env.GITHUB_EVENT_NAME === "pull_request",
    "ADAPTER_CONTEXT_REJECTED",
  );
  const run = integer(env.GITHUB_RUN_ID),
    attempt = integer(env.GITHUB_RUN_ATTEMPT);
  requireThat(attempt <= 2, "ADAPTER_ATTEMPT_REJECTED");
  const names = {
    source: "seaweedfs-candidate",
    seal: "seaweedfs-seal",
    walking: "qualified-storage",
    ci: "storage-receipt",
    outcome: "admission-outcome",
  };
  const cap = ["source", "walking"].includes(input.role)
    ? BOUNDS.source_zip
    : { seal: 8472, ci: 16674, outcome: 4402 }[input.role];
  const plan = {
    operation: input.operation,
    role: input.role,
    run,
    attempt,
    cap,
    name: `${names[input.role]}-${run}-${attempt}`,
    members: MEMBERS[input.role],
  };
  if (input.operation === "upload") {
    requireThat(
      input.bundle && !["artifact-id", "artifact-digest", "artifact-bytes"].some((k) => input[k]),
      "ADAPTER_UPLOAD_INPUT_REJECTED",
    );
    plan.bundle = path.resolve(input.bundle);
  } else {
    requireThat(!input.bundle, "ADAPTER_DOWNLOAD_INPUT_REJECTED");
    plan.id = integer(input["artifact-id"]);
    plan.bytes = integer(input["artifact-bytes"]);
    requireThat(
      /^sha256:[a-f0-9]{64}$/.test(input["artifact-digest"] ?? "") && plan.bytes <= cap,
      "ADAPTER_DIGEST_OR_SIZE_INVALID",
    );
    plan.digest = input["artifact-digest"];
  }
  return plan;
}
export function boundedEnvironment(env, work) {
  const out = {
    PATH: "/usr/bin:/bin",
    HOME: work,
    TMPDIR: work,
    TZ: "UTC",
    LANG: "C.UTF-8",
    NODE_OPTIONS: "--max-old-space-size=256",
    ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY: "2",
  };
  // Only genuine runner-issued runtime credentials are inherited. No caller
  // token, proxy, preload, shell, arbitrary INPUT_*, or NODE_OPTIONS survives.
  for (const k of [
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_RUNTIME_URL",
    "ACTIONS_RESULTS_URL",
    "ACTIONS_CACHE_URL",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_REPOSITORY",
    "GITHUB_WORKSPACE",
    "GITHUB_ACTIONS",
    "GITHUB_EVENT_NAME",
    "RUNNER_OS",
  ]) {
    if (env[k]) out[k] = env[k];
  }
  return out;
}
export function officialInputs(plan, admission, work, env) {
  requireThat(
    typeof env.ACTIONS_RUNTIME_TOKEN === "string" &&
      env.ACTIONS_RUNTIME_TOKEN.length > 0 &&
      typeof env.ACTIONS_RESULTS_URL === "string" &&
      env.ACTIONS_RESULTS_URL.length > 0,
    "ARTIFACT_RUNTIME_CREDENTIALS_MISSING",
  );
  const endpoint = new URL(env.ACTIONS_RESULTS_URL);
  requireThat(
    endpoint.protocol === "https:" &&
      !endpoint.port &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.hash &&
      endpoint.hostname.endsWith(".actions.githubusercontent.com"),
    "ARTIFACT_RUNTIME_ORIGIN_REJECTED",
  );
  if (plan.operation === "upload")
    return {
      name: plan.name,
      path: plan.members.map((n) => path.join(plan.bundle, n)).join("\n"),
      "if-no-files-found": "error",
      "retention-days": "1",
      "compression-level": "0",
      overwrite: "false",
      "include-hidden-files": "true",
      archive: "true",
    };
  const inputs = {
    "artifact-ids": String(plan.id),
    path: path.join(work, "raw"),
    "skip-decompress": "true",
    "digest-mismatch": "error",
    "merge-multiple": "true",
    repository: "mahmoudemad68/Your_Editor",
    "run-id": String(admission.run_id),
  };
  if (["walking", "ci"].includes(plan.role))
    requireThat(admission.run_id === plan.run, "ADAPTER_SAME_RUN_IDENTITY_DRIFT");
  if (admission.run_id !== plan.run) {
    requireThat(
      typeof env.GITHUB_TOKEN === "string" && env.GITHUB_TOKEN.length > 0,
      "CROSS_RUN_READ_TOKEN_REQUIRED",
    );
    inputs["github-token"] = env.GITHUB_TOKEN;
  }
  return inputs;
}
export async function verifyRawOutput(directory, expected) {
  const names = await readdir(directory);
  requireThat(names.length === 1, "RAW_DOWNLOAD_NOT_SINGLE_FILE");
  requireThat(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(names[0]) && ![".", ".."].includes(names[0]),
    "RAW_DOWNLOAD_NAME_UNSAFE",
  );
  const file = path.join(directory, names[0]);
  const s = await lstat(file);
  requireThat(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1 &&
      s.size === expected.bytes &&
      s.size <= expected.cap,
    "RAW_DOWNLOAD_SIZE_OR_TYPE",
  );
  requireThat(
    `sha256:${hash(await readFile(file))}` === expected.digest,
    "RAW_DOWNLOAD_DIGEST_MISMATCH",
  );
  return file;
}
export async function verifyUploadFiles(plan) {
  const s = await lstat(plan.bundle);
  requireThat(
    s.isDirectory() && !s.isSymbolicLink() && (await realpath(plan.bundle)) === plan.bundle,
    "UPLOAD_DIRECTORY_UNSAFE",
  );
  const names = await readdir(plan.bundle);
  requireThat(
    names.length === plan.members.length && names.every((n) => plan.members.includes(n)),
    "UPLOAD_MEMBER_SET_REJECTED",
  );
  let bytes = 0;
  for (const name of plan.members) {
    const f = await lstat(path.join(plan.bundle, name));
    requireThat(
      f.isFile() && !f.isSymbolicLink() && f.nlink === 1 && f.size > 0,
      "UPLOAD_FILE_UNSAFE",
    );
    bytes += f.size;
  }
  requireThat(
    bytes + 164 * names.length + 2 * names.reduce((n, s) => n + s.length, 0) + 98 <= plan.cap,
    "UPLOAD_ENVELOPE_OVER_BUDGET",
  );
  return bytes;
}
export async function pinnedAction(work, operation) {
  const pin = OFFICIAL[operation];
  requireThat(pin, "OFFICIAL_ACTION_UNKNOWN");
  const dir = path.join(work, "official");
  await mkdir(dir, { mode: 0o700 });
  for (const [source, dest, expected, cap] of [
    [pin.entry, "index.js", pin.sha256, pin.bytes],
    ["package.json", "package.json", pin.package_sha256, 65536],
    ["action.yml", "action.yml", pin.action_sha256, 16384],
  ]) {
    const response = await globalThis.fetch(
      `https://raw.githubusercontent.com/actions/${pin.repo}/${pin.commit}/${source}`,
      {
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(20000),
        headers: { Accept: "application/octet-stream" },
      },
    );
    requireThat(response.ok && response.body, "OFFICIAL_ACTION_UNAVAILABLE");
    const parts = [];
    let bytes = 0;
    for await (const part of response.body) {
      bytes += part.length;
      requireThat(bytes <= cap, "OFFICIAL_ACTION_OVERSIZE");
      parts.push(part);
    }
    const data = Buffer.concat(parts);
    requireThat(hash(data) === expected, "OFFICIAL_ACTION_HASH_MISMATCH");
    validatePinnedBytes(
      operation,
      source === pin.entry ? "entry" : source === "package.json" ? "package" : "action",
      data,
    );
    await writeFile(path.join(dir, dest), data, { flag: "wx", mode: 0o600 });
  }
  return path.join(dir, "index.js");
}
const SUPERVISOR = String.raw`
import os,sys,json,time,resource,subprocess,signal
work,cap,node,entry,cpu_limit,wall_limit=sys.argv[1:];cap=int(cap);cpu_limit=int(cpu_limit);wall_limit=int(wall_limit)
def limits():
 resource.setrlimit(resource.RLIMIT_AS,(8589934592,8589934592))
 resource.setrlimit(resource.RLIMIT_CPU,(cpu_limit,cpu_limit))
 resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap))
 resource.setrlimit(resource.RLIMIT_CORE,(0,0))
start=time.monotonic();before=resource.getrusage(resource.RUSAGE_CHILDREN)
p=subprocess.Popen([node,entry],cwd=work,start_new_session=True,preexec_fn=limits,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print(json.dumps({'child_process_group':p.pid}),flush=True)
failure=None;peak=0
try:
 while p.poll() is None:
  size=0
  for root,dirs,files in os.walk(work,followlinks=False):
   for n in files:
    st=os.lstat(os.path.join(root,n))
    if not os.path.isfile(os.path.join(root,n)) or os.path.islink(os.path.join(root,n)): raise ValueError('unsafe child output')
    size+=st.st_size
  peak=max(peak,size)
  if size>402653184: failure='ADAPTER_SCRATCH_LIMIT';break
  if time.monotonic()-start>wall_limit: failure='ADAPTER_WALL_TIMEOUT';break
  time.sleep(.05)
except BaseException:
 failure='ADAPTER_SUPERVISOR_FAILURE'
finally:
 try: os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError: pass
 p.wait()
after=resource.getrusage(resource.RUSAGE_CHILDREN)
cpu=after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime
result={'exit_code':p.returncode,'signal':-p.returncode if p.returncode<0 else None,'wall_seconds':time.monotonic()-start,'cpu_seconds':cpu,'peak_rss_bytes':after.ru_maxrss*1024,'sampled_scratch_bytes':peak,'failure':failure}
print(json.dumps(result,separators=(',',':')))
sys.exit(1 if failure or p.returncode!=0 else 0)
`;
export async function supervise(
  work,
  cap,
  node,
  entry,
  env,
  reducedLimits = { cpu: BOUNDS.cpu, wall: BOUNDS.wall },
) {
  // Tests can tighten CPU/wall bounds to exercise actual termination quickly.
  // No Action input or environment switch can raise or override production caps.
  requireThat(
    Number.isSafeInteger(cap) &&
      cap > 0 &&
      cap <= BOUNDS.source_zip &&
      Object.keys(reducedLimits).sort().join(",") === "cpu,wall" &&
      Number.isSafeInteger(reducedLimits.cpu) &&
      reducedLimits.cpu > 0 &&
      reducedLimits.cpu <= BOUNDS.cpu &&
      Number.isSafeInteger(reducedLimits.wall) &&
      reducedLimits.wall > 0 &&
      reducedLimits.wall <= BOUNDS.wall,
    "ADAPTER_LIMIT_INCREASE_REJECTED",
  );
  requireThat(
    process.platform === "linux" && process.versions.node.split(".")[0] === "24",
    "ADAPTER_LINUX_NODE24_REQUIRED",
  );
  requireThat(
    (await statfs(work)).bavail * (await statfs(work)).bsize >= 512 * 1024 ** 2,
    "ADAPTER_SCRATCH_UNAVAILABLE",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      "/usr/bin/python3",
      [
        "-I",
        "-c",
        SUPERVISOR,
        work,
        String(cap),
        node,
        entry,
        String(reducedLimits.cpu),
        String(reducedLimits.wall),
      ],
      { env, stdio: ["ignore", "pipe", "ignore"], detached: true },
    );
    let output = "",
      overflow = false,
      group = null;
    const cleanup = () => {
      for (const pid of [group, child.pid])
        if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already reaped */
          }
        }
    };
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new Error("ADAPTER_SUPERVISOR_TIMEOUT"));
      },
      (reducedLimits.wall + 10) * 1000,
    );
    child.stdout.on("data", (b) => {
      output += b;
      const line = output.split("\n")[0];
      try {
        const first = JSON.parse(line);
        if (Number.isSafeInteger(first.child_process_group) && first.child_process_group > 1)
          group = first.child_process_group;
      } catch {
        /* incomplete line */
      }
      if (output.length > 8192) {
        overflow = true;
        cleanup();
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("ADAPTER_SUPERVISOR_UNAVAILABLE"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      try {
        const report = JSON.parse(output.trim().split("\n").at(-1));
        requireThat(
          Number.isSafeInteger(report.exit_code) &&
            [
              report.wall_seconds,
              report.cpu_seconds,
              report.peak_rss_bytes,
              report.sampled_scratch_bytes,
            ].every((v) => Number.isFinite(v) && v >= 0),
          "ADAPTER_MEASUREMENT_INVALID",
        );
        if (overflow || code !== 0 || report.exit_code !== 0 || report.failure !== null) {
          const error = new Error("OFFICIAL_ACTION_FAILED");
          error.resources = {
            exit_code: report.exit_code,
            signal: report.signal,
            wall_seconds: report.wall_seconds,
            cpu_seconds: report.cpu_seconds,
            peak_rss_bytes: report.peak_rss_bytes,
            sampled_scratch_bytes: report.sampled_scratch_bytes,
          };
          reject(error);
          return;
        }
        resolve(report);
      } catch {
        reject(new Error("OFFICIAL_ACTION_FAILED"));
      }
    });
  });
}
export function parseOfficialOutputs(text, operation) {
  requireThat(text.length <= 8192, "OFFICIAL_OUTPUT_OVERSIZE");
  const result = {};
  const lines = text.trim().split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    if (!line) continue;
    const m =
      /^(artifact-id|artifact-digest|artifact-url|download-path)(?:=([^\r\n]*)|<<([A-Za-z0-9_-]+))$/.exec(
        line,
      );
    requireThat(m && !Object.hasOwn(result, m[1]), "OFFICIAL_OUTPUT_INVALID");
    if (m[3]) {
      requireThat(
        i + 1 < lines.length && lines[i + 1] === m[3],
        "OFFICIAL_OUTPUT_MULTILINE_REJECTED",
      );
      result[m[1]] = lines[i++];
      i++;
    } else result[m[1]] = m[2];
  }
  if (operation === "upload") {
    integer(result["artifact-id"]);
    requireThat(
      /^[a-f0-9]{64}$/.test(result["artifact-digest"] ?? ""),
      "OFFICIAL_OUTPUT_DIGEST_INVALID",
    );
  } else requireThat(typeof result["download-path"] === "string", "OFFICIAL_OUTPUT_PATH_MISSING");
  return result;
}
export async function execute(input, env = process.env) {
  const plan = artifactPlan(input, env);
  requireThat(
    process.platform === "linux" && process.versions.node.split(".")[0] === "24",
    "ADAPTER_LINUX_NODE24_REQUIRED",
  );
  const loader = await import("../../../tools/test/load-qualified-storage.mjs");
  // This is deliberately live admission, not a receipt/flag supplied by a caller.
  const admission = await loader.authorizeArtifactAdapter(plan);
  // Validate credential class before fetching/executing the pinned SDK.
  officialInputs(plan, admission, "unused-validation-only", env);
  const root = path.resolve(env.GITHUB_WORKSPACE);
  requireThat((await realpath(root)) === root, "WORKSPACE_UNSAFE");
  const parent = path.join(root, ".local/pc100-artifacts");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  requireThat((await realpath(parent)) === parent, "ADAPTER_SCRATCH_PATH_UNSAFE");
  const work = await mkdtemp(path.join(parent, "transfer-"));
  try {
    if (plan.operation === "upload") await verifyUploadFiles(plan);
    const entry = await pinnedAction(work, plan.operation);
    const childEnv = boundedEnvironment(env, work),
      output = path.join(work, "outputs");
    await writeFile(output, "", { flag: "wx", mode: 0o600 });
    childEnv.GITHUB_OUTPUT = output;
    const inputs = officialInputs(plan, admission, work, env);
    for (const [k, v] of Object.entries(inputs)) childEnv[`INPUT_${k.toUpperCase()}`] = v;
    const resources = await supervise(work, plan.cap, process.execPath, entry, childEnv);
    const actual = parseOfficialOutputs(await readFile(output, "utf8"), plan.operation);
    if (plan.operation === "download") {
      const file = await verifyRawOutput(path.join(work, "raw"), plan);
      return {
        "artifact-id": plan.id,
        "artifact-digest": plan.digest,
        "artifact-bytes": plan.bytes,
        "download-path": file,
        resources,
      };
    }
    const verified = await loader.verifyAdapterUpload(plan, actual, admission);
    await rm(work, { recursive: true, force: true });
    return { ...verified, resources };
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw error;
  }
}
// Repository scripts run Node22. Use only a Linux runner's immutable local
// Node24 toolcache executable for delegation, never a caller-selected command.
export async function runnerNode24() {
  requireThat(process.platform === "linux", "ADAPTER_LINUX_NODE24_REQUIRED");
  if (process.versions.node.split(".")[0] === "24") return process.execPath;
  const root = "/opt/hostedtoolcache/node";
  requireThat((await realpath(root)) === root, "NODE24_TOOLCACHE_UNTRUSTWORTHY");
  const versions = (await readdir(root))
    .filter((s) => /^24\.[0-9]+\.[0-9]+$/.test(s))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .reverse();
  requireThat(versions.length > 0, "NODE24_TOOLCACHE_UNAVAILABLE");
  const node = path.join(root, versions[0], "x64/bin/node"),
    s = await lstat(node);
  requireThat(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.uid === 0 &&
      (s.mode & 0o022) === 0 &&
      (await realpath(node)) === node,
    "NODE24_TOOLCACHE_UNTRUSTWORTHY",
  );
  return node;
}
export async function downloadRawArtifact(artifact, role, parent) {
  const node = await runnerNode24();
  const work = await mkdtemp(path.join(parent, "official-download-"));
  const output = path.join(work, "output");
  await writeFile(output, "", { mode: 0o600, flag: "wx" });
  const env = { ...process.env, GITHUB_OUTPUT: output };
  for (const k of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "BASH_ENV",
    "ENV",
    "OPENSSL_CONF",
  ])
    delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith("INPUT_")) delete env[k];
  Object.assign(env, {
    INPUT_OPERATION: "download",
    INPUT_ROLE: role,
    "INPUT_ARTIFACT-ID": String(artifact.id),
    "INPUT_ARTIFACT-DIGEST": artifact.digest,
    "INPUT_ARTIFACT-BYTES": String(artifact.size_in_bytes),
  });
  await new Promise((resolve, reject) => {
    const child = spawn(node, [fileURLToPath(import.meta.url)], { env, stdio: "ignore" });
    child.on("error", () => reject(new Error("BOUNDED_DOWNLOAD_START_FAILED")));
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("BOUNDED_DOWNLOAD_FAILED")),
    );
  });
  const values = {};
  for (const line of (await readFile(output, "utf8")).trim().split("\n")) {
    const at = line.indexOf("=");
    requireThat(
      at > 0 && !Object.hasOwn(values, line.slice(0, at)),
      "BOUNDED_DOWNLOAD_OUTPUT_INVALID",
    );
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  requireThat(
    values["artifact-id"] === String(artifact.id) &&
      values["artifact-digest"] === artifact.digest &&
      values["artifact-bytes"] === String(artifact.size_in_bytes),
    "BOUNDED_DOWNLOAD_IDENTITY_DRIFT",
  );
  const raw = values["download-path"];
  requireThat(
    typeof raw === "string" &&
      raw.startsWith(path.join(process.env.GITHUB_WORKSPACE, ".local/pc100-artifacts/")),
    "BOUNDED_DOWNLOAD_PATH_REJECTED",
  );
  await rm(work, { recursive: true, force: true });
  return raw;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = {};
  for (const k of [
    "operation",
    "role",
    "bundle",
    "artifact-id",
    "artifact-digest",
    "artifact-bytes",
  ])
    if (process.env[`INPUT_${k.toUpperCase()}`]) input[k] = process.env[`INPUT_${k.toUpperCase()}`];
  execute(input)
    .then(async (result) => {
      requireThat(process.env.GITHUB_OUTPUT, "ADAPTER_OUTPUT_MISSING");
      for (const [k, v] of Object.entries(result))
        if (k !== "resources") {
          requireThat(!/[\r\n]/.test(String(v)), "ADAPTER_OUTPUT_UNSAFE");
          await writeFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`, { flag: "a" });
        }
    })
    .catch((error) => {
      process.stderr.write(
        JSON.stringify({
          outcome: "PC100_BOUNDED_ARTIFACT_FAILED",
          resources: error.resources ?? null,
        }) + "\n",
      );
      process.exitCode = 1;
    });
}
