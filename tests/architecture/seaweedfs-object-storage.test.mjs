import process from "node:process";
/**
 * SeaweedFS replaces MinIO in the active Compose stack.
 * S3ObjectStorage stays the application adapter.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

test("the active stack publishes only the SeaweedFS S3 gateway", () => {
  const compose = read("compose.yaml");
  const dockerfile = read("infra/seaweedfs/Dockerfile");
  assert.match(
    dockerfile,
    /chrislusf\/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8/,
  );
  assert.equal(compose.includes("infra/minio/Dockerfile"), false);
  assert.match(compose, /storage_internal:\n {4}internal: true/);
  assert.match(compose, /S3_ENDPOINT: http:\/\/seaweed-s3:8333/);
  assert.match(compose, /127\.0\.0\.1:\$\{S3_PORT/);
  assert.equal(compose.includes("minio-data:"), true);
  for (const service of ["seaweed-master:", "seaweed-volume:", "seaweed-filer:", "seaweed-s3:"]) {
    assert.equal(compose.includes(service), true, service);
  }
  const master = compose.slice(
    compose.indexOf("  seaweed-master:"),
    compose.indexOf("  seaweed-volume:"),
  );
  const volume = compose.slice(
    compose.indexOf("  seaweed-volume:"),
    compose.indexOf("  seaweed-filer:"),
  );
  const filer = compose.slice(
    compose.indexOf("  seaweed-filer:"),
    compose.indexOf("  seaweed-s3:"),
  );
  assert.equal(master.includes("ports:"), false);
  assert.equal(volume.includes("ports:"), false);
  assert.equal(filer.includes("ports:"), false);
  assert.match(read("apps/api/src/infrastructure/s3-object-storage.ts"), /IfNoneMatch: "\*"/);
  assert.match(read(".github/workflows/supply-chain.yml"), /infra\/seaweedfs\/Dockerfile/);
  assert.equal(
    read(".github/workflows/supply-chain.yml").includes("infra/minio/Dockerfile"),
    false,
  );
  assert.match(read(".github/dependabot.yml"), /\/infra\/seaweedfs/);
  assert.equal(read(".github/dependabot.yml").includes("/infra/minio"), false);
});

test("the S3 contract runs after the workspace install", () => {
  const workflow = read(".github/workflows/ci.yml");
  const pnpmSetup = workflow.indexOf("name: Install pnpm");
  const nodeSetup = workflow.indexOf("name: Setup Node.js");
  const install = workflow.indexOf("pnpm install --frozen-lockfile");
  const contract = workflow.indexOf("node tests/architecture/seaweedfs-s3-contract.mjs");
  const start = workflow.indexOf("name: Start SeaweedFS");
  assert.equal(pnpmSetup > 0 && nodeSetup > pnpmSetup, true);
  assert.equal(install > nodeSetup, true);
  assert.equal(contract > install, true);
  const startup = workflow.slice(start, pnpmSetup);
  assert.match(startup, /curl -fsS http:\/\/127\.0\.0\.1:9000\/status/);
  assert.match(startup, /ensure_bucket\.py/);
  assert.match(startup, /start-storage\.sh/);
  assert.match(startup, /verify-trust-boundary\.sh/);
  assert.equal(startup.includes("seaweedfs-s3-contract.mjs"), false);
  assert.match(
    read("tests/architecture/seaweedfs-s3-contract.mjs"),
    /If-None-Match duplicate returned 412/,
  );
  assert.match(
    read("tests/architecture/seaweedfs-s3-contract.mjs"),
    /anonymous GET returned the private object/,
  );
});

test("object migration refuses to delete historical volumes", () => {
  const script = read("infra/scripts/migrate-minio-objects.py");
  const backup = read("infra/seaweedfs/backup-volumes.sh");
  const restore = read("infra/seaweedfs/restore-volumes.sh");
  assert.equal(script.includes("volume rm"), false);
  assert.equal(script.includes("compose down"), false);
  assert.match(script, /does not delete source objects or volumes/);
  assert.equal(backup.includes("minio-data"), false);
  assert.equal(restore.includes("volume rm"), false);
  const rejected = spawnSync(
    process.env.TEST_PYTHON ?? "python3",
    [path.join(root, "infra/scripts/migrate-minio-objects.py"), "--delete-volumes"],
    { encoding: "utf8" },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /does not delete/);
});

test("storage components keep fixed addresses and reject anonymous master HTTP", () => {
  const compose = read("compose.yaml");
  const network = read("infra/seaweedfs/storage-network.env");
  const secrets = read("infra/seaweedfs/prepare-secrets.sh");
  const isolation = read("infra/seaweedfs/apply-host-isolation.sh");
  const verify = read("infra/seaweedfs/verify-trust-boundary.sh");
  assert.match(compose, /-disableHttp/);
  assert.match(compose, /https:\/\/127\.0\.0\.1:9333\/healthz/);
  assert.equal(compose.includes("/dir/status"), false);
  assert.match(network, /SEAWEED_SUBNET=172\.30\.210\.0\/24/);
  assert.match(network, /SEAWEED_MASTER_IP=172\.30\.210\.10/);
  assert.match(network, /SEAWEED_VOLUME_IP=172\.30\.210\.11/);
  assert.match(network, /SEAWEED_FILER_IP=172\.30\.210\.12/);
  assert.match(network, /SEAWEED_S3_IP=172\.30\.210\.13/);
  for (const ip of ["172.30.210.10", "172.30.210.11", "172.30.210.12", "172.30.210.13"]) {
    assert.equal(compose.includes(ip), true, ip);
  }
  assert.match(
    compose,
    /-whiteList=172\.30\.210\.10,172\.30\.210\.11,172\.30\.210\.12,172\.30\.210\.13/,
  );
  assert.match(secrets, /\[https\.master\]/);
  assert.match(secrets, /\[grpc\.client\]/);
  assert.match(secrets, /grpc_role\("master", "editagent-volume,editagent-filer,editagent-s3"\)/);
  assert.match(secrets, /grpc_role\("volume", "editagent-master,editagent-filer"\)/);
  assert.match(secrets, /volume write key stays off this file/);
  assert.equal(secrets.includes('allowed_commonNames = "editagent-seaweed"'), false);
  assert.match(isolation, /DOCKER-USER/);
  assert.match(isolation, /ExecStartPost/);
  assert.match(isolation, /-j DROP/);
  assert.match(isolation, /ESTABLISHED,RELATED/);
  assert.match(isolation, /still allows the whole subnet/);
  const master = compose.slice(
    compose.indexOf("  seaweed-master:"),
    compose.indexOf("  seaweed-volume:"),
  );
  assert.match(master, /restart: "no"/);
  assert.match(master, /disable_ipv6/);
  assert.match(master, /master\.crt/);
  assert.equal(master.includes("seaweed.crt"), false);
  assert.match(verify, /dir\/assign/);
  assert.match(verify, /vol_status/);
  assert.match(verify, /DiskStatuses/);
  assert.match(verify, /master issued a write token/);
  assert.equal(verify.includes("console.log"), false);
  const starter = read("infra/seaweedfs/start-storage.sh");
  assert.equal(
    starter.indexOf("apply-host-isolation.sh") < starter.indexOf("docker compose up"),
    true,
  );
  assert.equal(
    starter.indexOf("apply-container-firewall.sh") < starter.indexOf("docker compose up -d --wait"),
    true,
  );
  assert.match(starter, /REBOOT_PERSISTENCE=UNVERIFIED/);
  assert.match(read("infra/seaweedfs/Dockerfile"), /editagent-entrypoint.sh/);
  assert.match(read("infra/seaweedfs/docker-entrypoint.sh"), /editagent-startup\/id/);
  assert.match(read("infra/seaweedfs/docker-entrypoint.sh"), /refusing non-root/);
  assert.match(read("infra/seaweedfs/backup-volumes.sh"), /rearm-storage\.sh/);
  assert.match(read("infra/seaweedfs/restore-volumes.sh"), /rearm-storage\.sh/);
  assert.match(compose, /security\.s3\.toml:\/etc\/seaweedfs\/security\.toml/);
  assert.match(compose, /security\.volume\.toml:\/etc\/seaweedfs\/security\.toml/);
  assert.match(read("infra/seaweedfs/apply-container-firewall.sh"), /seaweed-volume 8080 18080/);
  assert.match(read("Makefile"), /start-storage\.sh/);
});

test("Route A recovery stays mandatory without extending CI or Walking deadlines", async () => {
  const ci = read(".github/workflows/ci.yml");
  const walking = read(".github/workflows/e2e.yml");
  const driver = read("tools/test/run-walking-skeleton.mjs");
  assert.match(ci, /run: node tests\/architecture\/seaweedfs-s3-contract\.mjs\n/);
  assert.match(ci, /name: repository checks\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 45/);
  assert.match(walking, /timeout-minutes: 15/);
  assert.match(walking, /pnpm test:walking-skeleton --verify-failure/);
  const recovery = driver.indexOf(
    '["tests/architecture/seaweedfs-s3-contract.mjs", "--verify-backup"]',
  );
  assert.ok(recovery > driver.indexOf("if (code !== 0) throw"));
  assert.ok(recovery < driver.indexOf("const readinessProof = await verifyReadinessCycles"));
  const invocation = driver.slice(driver.lastIndexOf("await command(", recovery), recovery + 300);
  assert.match(invocation, /await command\(\s*process\.execPath/);
  assert.match(invocation, /timeout: 240000/);
  assert.match(invocation, /S3_ENDPOINT:/);
  const { command } = await import("../../tools/test/compose-build.mjs");
  await command(process.execPath, ["-e", "process.exit(0)"], {
    env: {},
    stdio: "pipe",
    timeout: 2000,
  });
  await assert.rejects(
    command(process.execPath, ["-e", "process.exit(7)"], {
      env: {},
      stdio: "pipe",
      timeout: 2000,
    }),
    /exited 7/,
  );
});

// Evaluate the actual CLI with every service/process/filesystem effect intercepted.
// This is parser/control-flow evidence, not a real Docker or S3 qualification.
async function recoveryAdmissionProbe(root) {
  const assert = (await import("node:assert/strict")).default;
  const vm = await import("node:vm");
  const fs = await import("node:fs");
  const path = (await import("node:path")).default;
  const url = await import("node:url");
  const crypto = await import("node:crypto");
  const source = fs.readFileSync(
    path.join(root, "tests/architecture/seaweedfs-s3-contract.mjs"),
    "utf8",
  );
  const project = "walking-skeleton",
    socket = "unix:///var/run/docker.sock";
  const baseEnv = {
    COMPOSE_PROJECT_NAME: project,
    EDITAGENT_RUNTIME: "development",
    S3_ENDPOINT: "http://127.0.0.1:9000",
  };
  const roles = ["seaweed-master", "seaweed-volume", "seaweed-filer", "seaweed-s3"];
  async function execute(options = {}) {
    const env = { ...baseEnv, ...options.env },
      originalEnv = { ...env };
    const effects = { s3: 0, fetch: 0, writes: 0, shells: [], docker: 0 };
    let saved,
      deleted = false,
      puts = 0,
      masterReads = 0;
    const sdk = {};
    for (const name of [
      "CreateBucketCommand",
      "DeleteObjectCommand",
      "GetObjectCommand",
      "HeadObjectCommand",
      "PutObjectCommand",
    ])
      sdk[name] = class {
        constructor(input) {
          this.kind = name;
          this.input = input;
        }
      };
    sdk.S3Client = class {
      constructor() {
        effects.s3++;
      }
      async send(c) {
        effects.s3++;
        if (c.kind === "PutObjectCommand") saved = c.input;
        if (c.kind === "DeleteObjectCommand") deleted = true;
        if (c.kind === "HeadObjectCommand") {
          if (deleted) {
            const e = Error("deleted");
            e.$metadata = { httpStatusCode: 404 };
            throw e;
          }
          return { ContentType: saved.ContentType, ChecksumSHA256: saved.ChecksumSHA256 };
        }
        if (c.kind === "GetObjectCommand") {
          deleted = false;
          return { Body: { transformToByteArray: async () => saved.Body } };
        }
        return {};
      }
    };
    const containers = roles.map((role, i) => ({
      Id: String(i + 1).repeat(64),
      Image: "sha256:" + "a".repeat(64),
      State: { Running: true },
      Config: {
        Labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.service": role,
          "com.docker.compose.project.working_dir": root,
          "com.docker.compose.project.config_files": path.join(root, "compose.yaml"),
        },
      },
      HostConfig: { NetworkMode: "editagent-storage", Privileged: false },
      Mounts:
        role === "seaweed-s3"
          ? []
          : [
              {
                Type: "volume",
                Name: project + "_" + role,
                Destination: "/data",
                Source: "/virtual/owned/" + project + "_" + role,
                RW: true,
              },
            ],
      NetworkSettings: { Ports: { "8333/tcp": [{ HostIp: "127.0.0.1", HostPort: "9000" }] } },
    }));
    const volumes = roles.slice(0, 3).map((role) => ({
      Name: project + "_" + role,
      Driver: "local",
      Scope: "local",
      Options: null,
      Mountpoint: "/virtual/owned/" + project + "_" + role,
      Labels: {
        "com.docker.compose.project": project,
        "com.docker.compose.volume": role,
      },
    }));
    options.mutate?.(containers, volumes);
    const modules = {
      "node:module": {
        createRequire: () => (name) =>
          name === "@aws-sdk/client-s3"
            ? sdk
            : { getSignedUrl: async () => "http://never-requested.invalid/fixture" },
      },
      "node:crypto": crypto,
      "node:child_process": {
        spawnSync: (bin, args, opts) => {
          if (bin === "sh") {
            effects.shells.push(path.basename(args[0]));
            assert.equal(opts.env.COMPOSE_PROJECT_NAME, project);
            assert.equal(opts.env.COMPOSE_FILE, path.join(root, "compose.yaml"));
            assert.equal(opts.env.COMPOSE_DISABLE_ENV_FILE, "1");
            assert.equal(opts.env.S3_PORT, "9000");
            assert.equal(opts.env.DOCKER_HOST, socket);
            assert.equal(opts.env.DOCKER_CONTEXT, undefined);
            assert.equal(opts.timeout, 120000);
            return { status: 0 };
          }
          assert.equal(bin, "docker");
          effects.docker++;
          assert.deepEqual(Array.from(args.slice(0, 2)), ["--host", socket]);
          assert.equal(opts.timeout, 10000);
          assert.equal(opts.maxBuffer, 1048576);
          if (options.dockerFailure) return { status: 1, stdout: "" };
          const a = args.slice(2);
          if (a[0] === "ps") {
            const role = a.at(-1).slice("label=com.docker.compose.service=".length);
            if (role === "seaweed-master") {
              masterReads++;
              if (options.drift === masterReads) containers[0].Id = "e".repeat(64);
              if (options.physicalDrift === masterReads) {
                const moved = "/virtual/new-data-root/" + volumes[0].Name;
                containers[0].Mounts[0].Source = moved;
                volumes[0].Mountpoint = moved;
              }
            }
            const id = containers[roles.indexOf(role)].Id;
            return { status: 0, stdout: options.multiple ? id + "\n" + "f".repeat(64) : id };
          }
          if (options.malformed) return { status: 0, stdout: "not json" };
          const row =
            a[0] === "container"
              ? containers.find((c) => c.Id === a[2])
              : volumes.find((v) => v.Name === a[2]);
          assert.ok(row, "only expected read-only container/volume inspection may execute");
          return { status: 0, stdout: JSON.stringify([row]) };
        },
      },
      "node:fs": {
        mkdirSync: () => effects.writes++,
        mkdtempSync: () => {
          effects.writes++;
          return "/no-real-write/fixture";
        },
        rmSync: () => effects.writes++,
      },
      "node:path": { default: path },
      "node:url": url,
    };
    const ctx = vm.createContext({
      process: {
        env,
        argv: ["node", "contract", ...(options.normal ? [] : ["--verify-backup"])],
        platform: options.platform ?? "linux",
        exit: (c) => {
          throw Error("exit " + c);
        },
      },
      Buffer,
      console: { log() {}, error() {} },
      fetch: async (_url, o) => {
        effects.fetch++;
        return { status: o?.method === "PUT" ? (++puts === 1 ? 412 : 200) : 403 };
      },
    });
    const entry = new vm.SourceTextModule(source, {
      context: ctx,
      initializeImportMeta: (m) => {
        m.url = url.pathToFileURL(
          path.join(root, "tests/architecture/seaweedfs-s3-contract.mjs"),
        ).href;
      },
    });
    await entry.link(async (spec) => {
      const map = modules[spec];
      assert.ok(map, "unexpected dependency " + spec);
      return new vm.SyntheticModule(
        Object.keys(map),
        function () {
          for (const [k, v] of Object.entries(map)) this.setExport(k, v);
        },
        { context: ctx },
      );
    });
    let error;
    try {
      await entry.evaluate({ timeout: 2000 });
    } catch (e) {
      error = e.message;
    }
    assert.deepEqual(env, originalEnv, "admission must not mutate the caller environment");
    return { error, effects };
  }
  const cases = [
    ["missing project", { env: { COMPOSE_PROJECT_NAME: undefined } }],
    ["default production stack", { env: { COMPOSE_PROJECT_NAME: "editagent" } }],
    ["arbitrary project", { env: { COMPOSE_PROJECT_NAME: "production" } }],
    ["production runtime", { env: { EDITAGENT_RUNTIME: "production" } }],
    ["missing runtime", { env: { EDITAGENT_RUNTIME: undefined } }],
    ["missing endpoint", { env: { S3_ENDPOINT: undefined } }],
    ["remote endpoint", { env: { S3_ENDPOINT: "https://example.invalid:9000" } }],
    ["DNS alias", { env: { S3_ENDPOINT: "http://localhost:9000" } }],
    ["wrong port", { env: { S3_ENDPOINT: "http://127.0.0.1:9001" } }],
    ["endpoint userinfo", { env: { S3_ENDPOINT: "http://user@127.0.0.1:9000" } }],
    ["endpoint path", { env: { S3_ENDPOINT: "http://127.0.0.1:9000/path" } }],
    ["invalid port", { env: { S3_PORT: "65536" } }],
    ["remote daemon", { env: { DOCKER_HOST: "tcp://production.invalid:2375" } }],
    ["remote context", { env: { DOCKER_CONTEXT: "production" } }],
    ["compose override", { env: { COMPOSE_FILE: "production.yaml" } }],
    ["compose env override", { env: { COMPOSE_ENV_FILES: "production.env" } }],
    ["TLS daemon override", { env: { DOCKER_TLS_VERIFY: "1" } }],
    ["unsupported OS", { platform: "win32" }],
    ["Docker read failure", { dockerFailure: true }],
    ["ambiguous containers", { multiple: true }],
    ["malformed inspection", { malformed: true }],
    [
      "wrong container project",
      { mutate: (c) => (c[0].Config.Labels["com.docker.compose.project"] = "editagent") },
    ],
    [
      "wrong service",
      { mutate: (c) => (c[0].Config.Labels["com.docker.compose.service"] = "seaweed-filer") },
    ],
    [
      "wrong checkout",
      {
        mutate: (c) =>
          (c[0].Config.Labels["com.docker.compose.project.working_dir"] = "/production"),
      },
    ],
    [
      "wrong Compose source",
      {
        mutate: (c) =>
          (c[0].Config.Labels["com.docker.compose.project.config_files"] =
            "/production/compose.yaml"),
      },
    ],
    ["stopped container", { mutate: (c) => (c[0].State.Running = false) }],
    ["privileged container", { mutate: (c) => (c[0].HostConfig.Privileged = true) }],
    ["mixed images", { mutate: (c) => (c[3].Image = "sha256:" + "b".repeat(64)) }],
    ["production volume", { mutate: (c) => (c[0].Mounts[0].Name = "editagent_seaweed-master") }],
    ["host data bind", { mutate: (c) => (c[0].Mounts[0].Type = "bind") }],
    [
      "nested data override",
      { mutate: (c) => c[0].Mounts.push({ Destination: "/data/override", Name: "foreign" }) },
    ],
    [
      "wrong volume ownership",
      { mutate: (_c, v) => (v[0].Labels["com.docker.compose.project"] = "editagent") },
    ],
    [
      "wrong volume role",
      { mutate: (_c, v) => (v[0].Labels["com.docker.compose.volume"] = "seaweed-filer") },
    ],
    ["missing physical data source", { mutate: (c) => delete c[0].Mounts[0].Source }],
    ["remote volume driver", { mutate: (_c, v) => (v[0].Driver = "nfs") }],
    [
      "volume alias options",
      { mutate: (_c, v) => (v[0].Options = { device: "/production", o: "bind" }) },
    ],
    ["different physical data source", { mutate: (c) => (c[0].Mounts[0].Source = "/production") }],
    [
      "public port binding",
      { mutate: (c) => (c[3].NetworkSettings.Ports["8333/tcp"][0].HostIp = "0.0.0.0") },
    ],
    [
      "different actual port",
      { mutate: (c) => (c[3].NetworkSettings.Ports["8333/tcp"][0].HostPort = "9001") },
    ],
    [
      "multiple bindings",
      {
        mutate: (c) =>
          c[3].NetworkSettings.Ports["8333/tcp"].push({ HostIp: "127.0.0.1", HostPort: "9001" }),
      },
    ],
    ["host networking", { mutate: (c) => (c[3].HostConfig.NetworkMode = "host") }],
    ["forged CI flag", { env: { COMPOSE_PROJECT_NAME: "editagent", GITHUB_ACTIONS: "true" } }],
  ];
  for (const [name, options] of cases) {
    const r = await execute(options);
    assert.equal(r.error, "RECOVERY_REQUIRES_DISPOSABLE_WALKING_STACK", name);
    assert.equal(
      r.effects.s3 + r.effects.fetch + r.effects.writes + r.effects.shells.length,
      0,
      name,
    );
  }
  for (const github of [undefined, "false", "true"]) {
    const r = await execute({ env: { GITHUB_ACTIONS: github } });
    assert.equal(r.error, undefined, "genuinely inspected disposable shape");
    assert.deepEqual(r.effects.shells, ["backup-volumes.sh", "restore-volumes.sh"]);
  }
  for (const [drift, shells] of [
    [2, []],
    [3, ["backup-volumes.sh"]],
  ]) {
    const r = await execute({ drift });
    assert.equal(r.error, "RECOVERY_DISPOSABLE_STACK_CHANGED");
    assert.deepEqual(r.effects.shells, shells);
  }
  const moved = await execute({ physicalDrift: 3 });
  assert.equal(moved.error, "RECOVERY_DISPOSABLE_STACK_CHANGED");
  assert.deepEqual(moved.effects.shells, ["backup-volumes.sh"]);
  const normal = await execute({ normal: true, env: { COMPOSE_PROJECT_NAME: undefined } });
  assert.equal(normal.error, undefined);
  assert.equal(normal.effects.docker + normal.effects.shells.length, 0);
  console.log(
    JSON.stringify({
      negatives: cases.length,
      inspectedShapePositives: 3,
      identityDrift: 3,
      ordinaryContract: 1,
      actualDockerOrS3Calls: 0,
    }),
  );
}

test("RouteA-F1 actual recovery entry rejects unsafe ownership before any storage effect", () => {
  const code = `(${recoveryAdmissionProbe.toString()})(${JSON.stringify(root)}).catch(e => { console.error(e); process.exitCode = 1; });`;
  const r = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", "--input-type=module", "-e", code],
    {
      encoding: "utf8",
      env: {},
      timeout: 15000,
      maxBuffer: 1048576,
    },
  );
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}${r.error ?? ""}`);
  assert.match(r.stdout, /"negatives":42/);
  assert.match(r.stdout, /"actualDockerOrS3Calls":0/);
});

test("RouteA-F1 bare recovery CLI fails before package loading or any external command", () => {
  const r = spawnSync(
    process.execPath,
    [path.join(root, "tests/architecture/seaweedfs-s3-contract.mjs"), "--verify-backup"],
    {
      encoding: "utf8",
      env: {},
      timeout: 5000,
    },
  );
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /RECOVERY_REQUIRES_DISPOSABLE_WALKING_STACK/);
  assert.doesNotMatch(r.stderr, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/);
  assert.equal(r.stdout, "");
});
