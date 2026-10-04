/**
 * Secure SeaweedFS topology. The production S3 adapter is unchanged.
 * Anonymous reads must not return private object bytes from any listener.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(root, "apps/api/package.json"));
const { S3ObjectStorage } = require(
  path.join(root, "apps/api/dist/infrastructure/s3-object-storage.js"),
);
const image =
  "chrislusf/seaweedfs@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d";
const marker = "private-video-bytes-MUST-NOT-LEAK";
const accessKey = `spike-${randomBytes(6).toString("hex")}`;
const secretKey = randomBytes(24).toString("hex");
const project = "editagent-seaweedfs-secure";
const internalNetwork = "editagent-seaweed-internal";
const appNetwork = "editagent-seaweed-app";
const isolate = path.join(root, "infra/seaweedfs-spike/isolate-internal-network.sh");

function compose(args, env) {
  return spawnSync("docker", ["compose", "-f", "compose.seaweedfs-spike.yaml", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
}

function docker(args) {
  const result = run("docker", args);
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result.stdout.trim();
}

function runtimeIdentity() {
  const result = run("docker", ["run", "--rm", "--entrypoint", "id", image, "seaweed"]);
  assert.equal(result.status, 0, result.stderr);
  const uid = Number(result.stdout.match(/uid=(\d+)/)?.[1]);
  const gid = Number(result.stdout.match(/gid=(\d+)/)?.[1]);
  assert.equal(Number.isInteger(uid) && uid > 0, true, result.stdout);
  assert.equal(Number.isInteger(gid) && gid > 0, true, result.stdout);
  return { uid, gid };
}

function writeSecrets(directory) {
  const key = () => randomBytes(32).toString("base64url");
  writeFileSync(
    path.join(directory, "security.toml"),
    `[jwt.signing]
key = "${key()}"
expires_after_seconds = 60

[jwt.signing.read]
key = "${key()}"
expires_after_seconds = 60

[jwt.filer_signing]
key = "${key()}"
expires_after_seconds = 60

[jwt.filer_signing.read]
key = "${key()}"
expires_after_seconds = 60

[access]
ui = false

[filer.expose_directory_metadata]
enabled = false
`,
    { mode: 0o600 },
  );
  writeFileSync(
    path.join(directory, "s3.json"),
    JSON.stringify({
      identities: [
        {
          name: "editagent-spike",
          credentials: [{ accessKey, secretKey }],
          actions: ["Admin", "Read", "Write", "List", "Tagging"],
        },
      ],
    }),
    { mode: 0o600 },
  );
}

function ownSecrets(directory, identity) {
  chmodSync(directory, 0o700);
  const files = ["security.toml", "s3.json"].map((name) => path.join(directory, name));
  const owned = run("sudo", ["chown", `${identity.uid}:${identity.gid}`, ...files]);
  if (owned.status !== 0) {
    assert.fail(
      `cannot chown secrets to ${identity.uid}:${identity.gid}: ${owned.stderr || owned.stdout}`,
    );
  }
  const mode = run("sudo", ["chmod", "600", ...files]);
  if (mode.status !== 0) {
    assert.fail(`cannot chmod secrets to 0600: ${mode.stderr || mode.stdout}`);
  }
}

function assertSecretPermissions(directory, identity) {
  const directoryStat = statSync(directory);
  assert.equal(directoryStat.mode & 0o777, 0o700, "secret directory must be 0700");
  for (const name of ["security.toml", "s3.json"]) {
    const file = path.join(directory, name);
    const fileStat = statSync(file);
    assert.equal(fileStat.mode & 0o777, 0o600, `${name} must be 0600`);
    assert.equal(fileStat.uid, identity.uid, `${name} owner`);
    assert.equal(fileStat.gid, identity.gid, `${name} group`);
    const readable = run("docker", [
      "run",
      "--rm",
      "--user",
      `${identity.uid}:${identity.gid}`,
      "--entrypoint",
      "sh",
      "-v",
      `${file}:/check:ro`,
      image,
      "-c",
      "test -r /check && wc -c < /check",
    ]);
    assert.equal(
      readable.status,
      0,
      `${name} is not readable by the runtime user: ${readable.stderr}`,
    );
    assert.equal(Number(readable.stdout.trim()) > 0, true, `${name} was empty`);
    const denied = run("docker", [
      "run",
      "--rm",
      "--user",
      "65534:65534",
      "--entrypoint",
      "sh",
      "-v",
      `${file}:/check:ro`,
      image,
      "-c",
      "test -r /check",
    ]);
    assert.notEqual(denied.status, 0, `${name} was readable by an unrelated uid`);
  }
}

function bridgeName(network) {
  const id = docker(["network", "inspect", network, "--format", "{{.Id}}"]);
  return `br-${id.slice(0, 12)}`;
}

function containerIp(name) {
  return docker([
    "inspect",
    "-f",
    `{{(index .NetworkSettings.Networks "${internalNetwork}").IPAddress}}`,
    `${project}-${name}-1`,
  ]);
}

function listenPorts(name) {
  const result = run("docker", [
    "exec",
    `${project}-${name}-1`,
    "sh",
    "-c",
    "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null",
  ]);
  const ports = new Set();
  for (const line of result.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || parts[3] !== "0A") {
      continue;
    }
    const [address, portHex] = parts[1].split(":");
    if (address.endsWith("0100007F") || address.endsWith("0B00007F")) {
      continue;
    }
    if (portHex) {
      ports.add(Number.parseInt(portHex, 16));
    }
  }
  return [...ports].sort((left, right) => left - right);
}

function probe(url, network) {
  const result = network
    ? run("docker", [
        "run",
        "--rm",
        "--network",
        network,
        "--entrypoint",
        "wget",
        image,
        "-S",
        "-T",
        "1",
        "-O",
        "-",
        url,
      ])
    : run("curl", ["-sS", "-m", "1", "--connect-timeout", "1", "-D", "-", "-o", "-", url]);
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const statusMatch = text.match(/HTTP\/\d(?:\.\d)?\s+(\d+)/);
  return {
    status: statusMatch ? Number(statusMatch[1]) : 0,
    text,
  };
}

function assertNoBytes(result, label) {
  assert.equal(result.text.includes(marker), false, `${label} returned private bytes`);
}

function replaceVolume(volumeName, source) {
  const result = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "sh",
    "-v",
    `${volumeName}:/data`,
    "-v",
    `${source}:/backup:ro`,
    image,
    "-c",
    "find /data -mindepth 1 -delete && cp -a /backup/. /data/",
  ]);
  assert.equal(result.status, 0, `${volumeName}\n${result.stderr}\n${result.stdout}`);
}

async function eventually(action) {
  let lastError = new Error("operation was not attempted");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

test("secure SeaweedFS topology keeps private bytes behind S3", { timeout: 300_000 }, async () => {
  const secrets = mkdtempSync(path.join(tmpdir(), "seaweed-secrets-"));
  const evidencePath = path.join(tmpdir(), "seaweed-secure-evidence.txt");
  const identity = runtimeIdentity();
  writeSecrets(secrets);
  ownSecrets(secrets, identity);
  assertSecretPermissions(secrets, identity);
  const env = { SEAWEED_SECRET_DIR: secrets };
  const minioVolumesBefore = docker(["volume", "ls", "--format", "{{.Name}}"])
    .split("\n")
    .filter((name) => name.includes("minio"));
  const up = compose(["up", "-d"], env);
  assert.equal(up.status, 0, up.stderr + up.stdout);
  let firewall = null;
  const evidence = [];
  let step = "init";
  const note = (message) => {
    step = message;
    evidence.push(message);
    process.stderr.write(`STEP ${message}\n`);
  };
  try {
    const subnet = docker([
      "network",
      "inspect",
      internalNetwork,
      "--format",
      "{{(index .IPAM.Config 0).Subnet}}",
    ]);
    const bridge = bridgeName(internalNetwork);
    const appBridge = bridgeName(appNetwork);
    firewall = { subnet, bridge, appBridge, appSubnet: "" };
    const applied = run(isolate, ["apply", subnet, bridge]);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    const forwarded = run(isolate, ["allow-forward", appBridge]);
    assert.equal(forwarded.status, 0, forwarded.stderr + forwarded.stdout);
    const appSubnet = docker([
      "network",
      "inspect",
      appNetwork,
      "--format",
      "{{(index .IPAM.Config 0).Subnet}}",
    ]);
    firewall.appSubnet = appSubnet;
    const edged = run(isolate, ["apply-edge", appSubnet]);
    assert.equal(edged.status, 0, edged.stderr + edged.stdout);
    const verified = run(isolate, ["verify", subnet, bridge, appSubnet, appBridge]);
    assert.equal(verified.status, 0, `${verified.stderr}\n${verified.stdout}`);
    assert.equal(verified.stdout.includes("DOCKER-USER"), true, verified.stdout);
    assert.equal(verified.stdout.includes(subnet), true, verified.stdout);
    assert.equal(verified.stdout.includes("DROP"), true, verified.stdout);
    note(`runtime-uid=${identity.uid} runtime-gid=${identity.gid}`);
    note(verified.stdout.trim());
    const ready = compose(["up", "-d", "--wait", "--wait-timeout", "120"], env);
    if (ready.status !== 0) {
      const logs = compose(["logs", "--no-color", "--tail", "80", "s3"], env);
      assert.equal(
        ready.status,
        0,
        `${ready.stderr}${ready.stdout}\n${logs.stdout}\n${logs.stderr}`,
      );
    }
    note("ready");

    const direct = new S3ObjectStorage({
      endpoint: "http://127.0.0.1:18333",
      publicEndpoint: "http://127.0.0.1:18333",
      bucket: "editagent-spike",
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      region: "us-east-1",
    });
    const body = Buffer.from(marker);
    const hash = createHash("sha256").update(body).digest("hex");
    const key = `media/${hash}.mp4`;
    note("bucket");
    await direct.ensureBucket();
    note("put");
    await direct.put(key, body, "video/mp4", hash);
    const stored = await direct.stat(key);
    assert.equal(stored?.checksumSha256Hex, hash);
    assert.equal(stored?.contentType, "video/mp4");
    assert.deepEqual(Buffer.from(await direct.get(key)), body);

    const ingress = new S3ObjectStorage({
      endpoint: "http://127.0.0.1:18333",
      publicEndpoint: "http://127.0.0.1:18081",
      bucket: "editagent-spike",
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
      region: "us-east-1",
    });
    const signedKey = `signed/${hash}.mp4`;
    const presigned = await ingress.presignPut({
      key: signedKey,
      contentType: "video/mp4",
      checksumSha256Hex: hash,
      expiresInSeconds: 90,
      onlyIfAbsent: true,
    });
    assert.equal(new URL(presigned.url).host, "127.0.0.1:18081");
    const uploaded = await fetch(presigned.url, {
      method: "PUT",
      headers: presigned.requiredHeaders,
      body,
    });
    note("presign");
    assert.equal(uploaded.status, 200, await uploaded.text());
    const tampered = await fetch(presigned.url, {
      method: "PUT",
      headers: presigned.requiredHeaders,
      body: Buffer.from("not-the-signed-body"),
    });
    assert.notEqual(tampered.status, 200);
    assert.equal(
      (
        await fetch(presigned.url, {
          method: "PUT",
          headers: { ...presigned.requiredHeaders, "Content-Type": "text/plain" },
          body,
        })
      ).status,
      403,
    );
    const missingMatch = { ...presigned.requiredHeaders };
    delete missingMatch["If-None-Match"];
    assert.equal(
      (await fetch(presigned.url, { method: "PUT", headers: missingMatch, body })).status,
      403,
    );
    const missingChecksum = { ...presigned.requiredHeaders };
    delete missingChecksum["x-amz-checksum-sha256"];
    assert.equal(
      (await fetch(presigned.url, { method: "PUT", headers: missingChecksum, body })).status,
      403,
    );
    assert.equal(
      (
        await fetch(presigned.url, {
          method: "PUT",
          headers: presigned.requiredHeaders,
          body,
        })
      ).status,
      412,
    );
    note("signed-checks");
    const completed = await direct.stat(signedKey);
    assert.equal(completed?.checksumSha256Hex, hash);

    const filerIp = containerIp("filer");
    const volumeIp = containerIp("volume");
    const masterIp = containerIp("master");
    const s3Ip = containerIp("s3");
    const objectPath = `/buckets/editagent-spike/${signedKey}`;
    const filerUrl = `http://${filerIp}:8888${objectPath}`;
    note("matrix");
    const checks = [
      ["host", "filer-object", null, filerUrl, 0],
      ["host", "volume-root", null, `http://${volumeIp}:8080/`, 0],
      ["host", "master-status", null, `http://${masterIp}:9333/dir/status`, 0],
      ["host", "s3-internal-ip", null, `http://${s3Ip}:8333/editagent-spike/${signedKey}`, 0],
      ["host", "s3-published", null, `http://127.0.0.1:18333/editagent-spike/${signedKey}`, 403],
      ["host", "ingress", null, `http://127.0.0.1:18081/editagent-spike/${signedKey}`, 403],
      ["api-network", "filer-object", appNetwork, filerUrl, 0],
      ["api-network", "volume-root", appNetwork, `http://${volumeIp}:8080/`, 0],
      ["api-network", "master-status", appNetwork, `http://${masterIp}:9333/dir/status`, 0],
      ["sibling", "s3-unsigned", appNetwork, `http://s3:8333/editagent-spike/${signedKey}`, 403],
      ["other-network", "filer-object", "bridge", filerUrl, 0],
      ["other-network", "volume-root", "bridge", `http://${volumeIp}:8080/`, 0],
      ["internal", "filer-object", internalNetwork, filerUrl, 401],
      ["internal", "filer-root", internalNetwork, `http://${filerIp}:8888/`, 401],
      ["internal", "volume-root", internalNetwork, `http://${volumeIp}:8080/`, 401],
      ["internal", "volume-status", internalNetwork, `http://${volumeIp}:8080/status`, 200],
      ["internal", "volume-healthz", internalNetwork, `http://${volumeIp}:8080/healthz`, 200],
      ["internal", "filer-healthz", internalNetwork, `http://${filerIp}:8888/healthz`, 200],
    ];
    for (const [caller, target, network, url, expected] of checks) {
      const result = probe(url, network);
      evidence.push(`${caller} ${target} status=${result.status} expected=${expected}`);
      assertNoBytes(result, `${caller} ${target}`);
      assert.equal(result.status, expected, `${caller} ${target} status ${result.status}`);
    }

    const cat = run("docker", [
      "run",
      "--rm",
      "--network",
      internalNetwork,
      "--entrypoint",
      "weed",
      image,
      "filer.cat",
      filerUrl,
    ]);
    assertNoBytes({ text: `${cat.stdout}\n${cat.stderr}` }, "filer.cat");
    evidence.push(`internal filer.cat exit=${cat.status}`);

    const volumeFiles = run("docker", ["exec", `${project}-volume-1`, "ls", "/data"]);
    const volumeIds = [...volumeFiles.stdout.matchAll(/editagent-spike_(\d+)\.dat/g)].map(
      (match) => match[1],
    );
    const needleIds = [];
    for (const volumeId of volumeIds) {
      const exported = run("docker", [
        "exec",
        `${project}-volume-1`,
        "weed",
        "export",
        "-dir=/data",
        "-collection=editagent-spike",
        "-volumeId",
        volumeId,
        "-limit=20",
      ]);
      needleIds.push(
        ...(`${exported.stdout}\n${exported.stderr}`.match(/\b\d+,[0-9a-fA-F]{8,}\b/g) ?? []),
      );
    }
    assert.ok(needleIds.length > 0, `no needles in ${volumeFiles.stdout}`);
    evidence.push(`volume needles=${needleIds.join(",")}`);
    for (const needleId of needleIds) {
      const byHttp = probe(`http://${volumeIp}:8080/${needleId}`, internalNetwork);
      evidence.push(`internal volume-needle ${needleId} status=${byHttp.status}`);
      assertNoBytes(byHttp, `volume needle ${needleId}`);
      assert.notEqual(byHttp.status, 200, `volume needle ${needleId} was readable`);
      const byMaster = run("docker", [
        "run",
        "--rm",
        "--network",
        internalNetwork,
        "--entrypoint",
        "sh",
        image,
        "-c",
        `weed download -master=master:9333 -dir=/tmp ${needleId} >/tmp/log 2>&1; find /tmp -type f -exec cat {} +`,
      ]);
      assertNoBytes(
        { text: `${byMaster.stdout}\n${byMaster.stderr}` },
        `weed download ${needleId}`,
      );
    }

    const ingressRead = run("docker", [
      "exec",
      `${project}-object-ingress-1`,
      "node",
      "-e",
      `fetch(${JSON.stringify(filerUrl)},{signal:AbortSignal.timeout(2000)}).then(async (response)=>{console.log("STATUS",response.status);console.log(await response.text())}).catch((error)=>console.log("ERR",error.message))`,
    ]);
    assertNoBytes(
      { text: `${ingressRead.stdout}\n${ingressRead.stderr}` },
      "object ingress to filer",
    );
    assert.equal(`${ingressRead.stdout}`.includes("STATUS 200"), false);
    evidence.push(`object-ingress filer ${ingressRead.stdout.trim()}`);

    note("listeners");
    for (const name of ["master", "volume", "filer", "s3"]) {
      const ports = listenPorts(name);
      evidence.push(`${name} ports=${ports.join(",")}`);
      const ip = containerIp(name);
      for (const port of ports) {
        for (const [caller, network] of [
          ["host", null],
          ["app", appNetwork],
          ["other", "bridge"],
        ]) {
          const result = probe(`http://${ip}:${port}/`, network);
          evidence.push(`${caller} ${name}:${port} status=${result.status}`);
          assertNoBytes(result, `${caller} ${name}:${port}`);
          assert.equal(result.status, 0, `${caller} reached internal ${name}:${port}`);
        }
        const fromInternal = probe(`http://${ip}:${port}/`, internalNetwork);
        evidence.push(`internal ${name}:${port} status=${fromInternal.status}`);
        assertNoBytes(fromInternal, `internal ${name}:${port}`);
        const topologyOnly = name === "master";
        const signedGateway = name === "s3" && port === 8333;
        if (!topologyOnly && !signedGateway) {
          assert.notEqual(fromInternal.status, 200, `internal ${name}:${port} returned 200`);
        }
        if (signedGateway) {
          assert.equal(
            fromInternal.status,
            403,
            `internal s3 unsigned status ${fromInternal.status}`,
          );
        }
      }
    }
    const s3FromApp = probe("http://s3:8333/editagent-spike/", appNetwork);
    assert.equal(s3FromApp.status, 403);
    assertNoBytes(s3FromApp, "app network s3");
    const s3AppIp = docker([
      "inspect",
      "-f",
      `{{(index .NetworkSettings.Networks "${appNetwork}").IPAddress}}`,
      `${project}-s3-1`,
    ]);
    for (const port of listenPorts("s3")) {
      for (const [caller, network] of [
        ["host", null],
        ["sibling", appNetwork],
      ]) {
        const result = probe(`http://${s3AppIp}:${port}/`, network);
        evidence.push(`${caller} s3-app:${port} status=${result.status}`);
        assertNoBytes(result, `${caller} s3-app:${port}`);
        assert.equal(
          result.status,
          port === 8333 ? 403 : 0,
          `${caller} s3-app:${port} status ${result.status}`,
        );
      }
    }

    const masterFromInternal = probe(`http://${masterIp}:9333/dir/status`, internalNetwork);
    assertNoBytes(masterFromInternal, "master topology");
    evidence.push(`internal master-status status=${masterFromInternal.status}`);

    const stats = run("docker", [
      "stats",
      "--no-stream",
      "--format",
      "{{.Name}} mem={{.MemUsage}} cpu={{.CPUPerc}}",
    ]);
    for (const line of stats.stdout.split("\n")) {
      if (line.includes(project)) {
        evidence.push(`stats ${line.trim()}`);
      }
    }

    note("restart");
    const restarted = compose(["restart", "volume", "filer", "s3"], env);
    assert.equal(restarted.status, 0, restarted.stderr + restarted.stdout);
    let readableAfterRestart = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const again = await direct.stat(signedKey).catch(() => null);
      if (again?.checksumSha256Hex === hash) {
        readableAfterRestart = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(readableAfterRestart, true);

    note("backup");
    const backup = mkdtempSync(path.join(tmpdir(), "seaweed-backup-"));
    const stopped = compose(["stop", "s3", "filer", "volume"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    docker(["cp", `${project}-volume-1:/data`, path.join(backup, "volume")]);
    docker(["cp", `${project}-filer-1:/data`, path.join(backup, "filer")]);
    const started = compose(["start", "volume", "filer", "s3"], env);
    assert.equal(started.status, 0, started.stderr);
    await eventually(() => direct.delete(signedKey));
    const stoppedAgain = compose(["stop", "s3", "filer", "volume"], env);
    assert.equal(stoppedAgain.status, 0, stoppedAgain.stderr);
    replaceVolume(`${project}_seaweed-volume`, path.join(backup, "volume"));
    replaceVolume(`${project}_seaweed-filer`, path.join(backup, "filer"));
    const restoredServices = compose(["start", "volume", "filer", "s3"], env);
    assert.equal(restoredServices.status, 0, restoredServices.stderr);
    let restored = null;
    let restoreError = "not-read";
    for (let attempt = 0; attempt < 45; attempt += 1) {
      try {
        restored = await direct.get(signedKey);
        restoreError = `bytes=${restored?.byteLength ?? 0}`;
        if (restored !== null && Buffer.from(restored).equals(body)) {
          break;
        }
      } catch (error) {
        restoreError = `${error.name}: ${error.message}`;
        restored = null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(Buffer.from(restored ?? []).equals(body), true, restoreError);
    rmSync(backup, { recursive: true, force: true });
    note("done");
    evidence.push("restart=pass backup=pass");
    writeFileSync(evidencePath, `${evidence.join("\n")}\n`);
  } catch (error) {
    writeFileSync(evidencePath, `${evidence.join("\n")}\nFAIL ${step}\n${error?.stack ?? error}\n`);
    throw error;
  } finally {
    if (firewall) {
      if (firewall.appSubnet) {
        run(isolate, ["remove-edge", firewall.appSubnet]);
      }
      run(isolate, ["remove", firewall.subnet, firewall.bridge]);
      run(isolate, ["remove-forward", firewall.appBridge]);
    }
    compose(["down", "-v"], env);
    rmSync(secrets, { recursive: true, force: true });
    assert.equal(existsSync(secrets), false, "generated secrets were not removed");
    const minioVolumesAfter = docker(["volume", "ls", "--format", "{{.Name}}"])
      .split("\n")
      .filter((name) => name.includes("minio"));
    assert.deepEqual(minioVolumesAfter, minioVolumesBefore);
  }
});

test(
  "development Compose SeaweedFS topology keeps the adapter guarantees",
  { timeout: 300_000 },
  async () => {
    const secrets = mkdtempSync(path.join(tmpdir(), "seaweed-compose-secrets-"));
    const projectName = "editagent-storage-it";
    const env = {
      ...process.env,
      SEAWEED_SECRET_DIR: secrets,
      S3_ACCESS_KEY_ID: "editagent",
      S3_SECRET_ACCESS_KEY: "editagent-dev-secret",
      S3_PORT: "19083",
      OBJECTS_PORT: "19081",
    };
    const prepared = run(path.join(root, "infra/seaweedfs/prepare-secrets.sh"), [], { env });
    assert.equal(prepared.status, 0, prepared.stderr + prepared.stdout);
    const runtimeUid = Number(prepared.stdout.match(/uid=(\d+)/)?.[1]);
    const runtimeGid = Number(prepared.stdout.match(/gid=(\d+)/)?.[1]);
    assert.equal(runtimeUid > 0, true, prepared.stdout);
    for (const name of ["security.toml", "s3.json"]) {
      const fileStat = statSync(path.join(secrets, name));
      assert.equal(fileStat.mode & 0o777, 0o600);
      assert.equal(fileStat.uid, runtimeUid);
      assert.equal(fileStat.gid, runtimeGid);
    }
    assert.equal(statSync(secrets).mode & 0o777, 0o700);
    const minioVolumesBefore = docker(["volume", "ls", "--format", "{{.Name}}"])
      .split("\n")
      .filter((name) => name.includes("minio"));
    const composeDev = (args) =>
      run("docker", ["compose", "-p", projectName, "-f", "compose.yaml", ...args], { env });
    const up = run(
      path.join(root, "infra/seaweedfs/secure-up.sh"),
      [
        "compose.yaml",
        "-p",
        projectName,
        "--",
        "master",
        "volume",
        "filer",
        "s3",
        "object-ingress",
      ],
      { env },
    );
    assert.equal(up.status, 0, up.stderr + up.stdout);
    const lines = up.stdout.split("\n");
    const verifiedAt = lines.findIndex((line) => line.includes("isolation-verified"));
    const blockedAt = lines.findIndex((line) => line.includes("bootstrap-host-blocked"));
    const publishedAt = lines.findIndex((line) => line.includes("published-services-started"));
    assert.equal(
      verifiedAt >= 0 && blockedAt > verifiedAt && publishedAt > blockedAt,
      true,
      up.stdout,
    );
    assert.match(up.stdout, /bootstrap-host-blocked status=000 curl_exit=28/);
    try {
      const storage = new S3ObjectStorage({
        endpoint: "http://127.0.0.1:19083",
        publicEndpoint: "http://127.0.0.1:19081",
        bucket: "editagent",
        accessKeyId: "editagent",
        secretAccessKey: "editagent-dev-secret",
        region: "us-east-1",
      });
      const body = Buffer.from(marker);
      const hash = createHash("sha256").update(body).digest("hex");
      const key = `compose/${hash}.mp4`;
      await storage.ensureBucket();
      await storage.put(key, body, "video/mp4", hash);
      assert.equal((await storage.stat(key))?.checksumSha256Hex, hash);
      const presigned = await storage.presignPut({
        key: `compose-signed/${hash}.mp4`,
        contentType: "video/mp4",
        checksumSha256Hex: hash,
        expiresInSeconds: 90,
        onlyIfAbsent: true,
      });
      assert.equal(new URL(presigned.url).host, "127.0.0.1:19081");
      assert.equal(
        (await fetch(presigned.url, { method: "PUT", headers: presigned.requiredHeaders, body }))
          .status,
        200,
      );
      assert.equal(
        (await fetch(presigned.url, { method: "PUT", headers: presigned.requiredHeaders, body }))
          .status,
        412,
      );
      const filerIp = docker([
        "inspect",
        "-f",
        '{{(index .NetworkSettings.Networks "editagent-storage-internal").IPAddress}}',
        `${projectName}-filer-1`,
      ]);
      const filer = probe(`http://${filerIp}:8888/buckets/editagent/compose-signed/${hash}.mp4`);
      assertNoBytes(filer, "compose filer");
      assert.notEqual(filer.status, 200);
      const unsigned = probe(`http://127.0.0.1:19083/editagent/compose-signed/${hash}.mp4`);
      assertNoBytes(unsigned, "compose s3");
      assert.equal(unsigned.status, 403);
      assert.equal(composeDev(["restart", "s3", "filer", "volume"]).status, 0);
      let readable = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const again = await storage.stat(`compose-signed/${hash}.mp4`).catch(() => null);
        if (again?.checksumSha256Hex === hash) {
          readable = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(readable, true);
      assert.equal(composeDev(["up", "-d", "--force-recreate", "--no-deps", "filer"]).status, 0);
      const recreatedIp = docker([
        "inspect",
        "-f",
        '{{(index .NetworkSettings.Networks "editagent-storage-internal").IPAddress}}',
        `${projectName}-filer-1`,
      ]);
      const recreated = probe(`http://${recreatedIp}:8888/`);
      assertNoBytes(recreated, "recreated filer");
      assert.equal(recreated.status, 0);
      assert.equal(
        docker(["inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", `${projectName}-filer-1`]),
        "no",
      );
    } finally {
      composeDev(["stop"]);
      run(
        "sh",
        [
          "-c",
          '. .local/isolation-editagent-storage-it.state && infra/seaweedfs/install-host-isolation.sh remove "$saved_subnet" "$saved_bridge" "$saved_app_subnet" "$saved_app_bridge" "$saved_published"',
        ],
        {
          env,
        },
      );
      composeDev(["down"]);
      rmSync(secrets, { recursive: true, force: true });
      assert.equal(existsSync(secrets), false);
      const minioVolumesAfter = docker(["volume", "ls", "--format", "{{.Name}}"])
        .split("\n")
        .filter((name) => name.includes("minio"));
      assert.deepEqual(minioVolumesAfter, minioVolumesBefore);
    }
  },
);

test("secure-up fails closed without firewall privileges", () => {
  const result = run(
    "sudo",
    ["-u", "nobody", "--", path.join(root, "infra/seaweedfs/secure-up.sh"), "compose.yaml"],
    {},
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /unsupported firewall/);
});

test("secure-up fails closed when the firewall backend is missing", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "editagent-no-iptables-"));
  const result = run(
    path.join(root, "infra/seaweedfs/install-host-isolation.sh"),
    ["apply", "10.254.0.0/24", "br-missing", "10.254.1.0/24", "br-missing2", "-"],
    { env: { ...process.env, EDITAGENT_FIREWALL_BIN_DIR: directory } },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no iptables binary/);
  rmSync(directory, { recursive: true, force: true });
});

test("firewall verify fails closed when the required rules are absent", () => {
  const result = run(path.join(root, "infra/seaweedfs/install-host-isolation.sh"), [
    "verify",
    "10.254.0.0/24",
    "br-not-a-bridge",
    "10.254.1.0/24",
    "br-not-another",
    "-",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not effective|unsupported firewall/);
});
