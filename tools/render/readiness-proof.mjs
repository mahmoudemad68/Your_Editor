import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/** Start with S3 disconnected, rather than briefly advertising false readiness. */
export function verifyStorageStartup(coordinator) {
  const output = execFileSync(
    "docker",
    [
      "exec",
      coordinator,
      "node",
      "-e",
      "(async()=>{const deadline=Date.now()+30000;while(Date.now()<deadline){try{const ready=await fetch('http://127.0.0.1:3200/ready',{signal:AbortSignal.timeout(5000)});const health=await fetch('http://127.0.0.1:3200/health');console.log(JSON.stringify({ready:ready.status,health:health.status}));return;}catch{await new Promise(r=>setTimeout(r,50));}}throw new Error('Health server did not start');})().catch(()=>process.exitCode=1)",
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);
  assert.equal(result.ready, 503, "Startup with unavailable S3 must not advertise readiness");
  assert.equal(result.health, 200);
  return result;
}

/** Real coordinator image, unchanged isolation, real S3; no mocked SDK/events. */
export async function verifyStorageReadiness({ coordinator, storage, network }) {
  const docker = (args) => execFileSync("docker", args, { encoding: "utf8" });
  const probe = () =>
    JSON.parse(
      docker([
        "exec",
        coordinator,
        "node",
        "-e",
        "(async()=>{const start=performance.now();const [ready,health]=await Promise.all(['/ready','/health'].map(async path=>{const r=await fetch('http://127.0.0.1:3200'+path,{signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.text()};}));console.log(JSON.stringify({ready,health,durationMs:Math.round(performance.now()-start)}));})().catch(()=>process.exitCode=1)",
      ]),
    );
  const identity = () =>
    docker(["inspect", "--format", "{{.State.StartedAt}} {{.RestartCount}}", coordinator]).trim();
  const originalIdentity = identity();
  const rows = [];
  const check = (phase, expected) => {
    const result = probe();
    assert.equal(result.ready.status, expected, phase);
    assert.equal(result.health.status, 200, "S3 outage is not process liveness");
    assert.deepEqual(JSON.parse(result.ready.body), {
      status: expected === 200 ? "ready" : "not-ready",
    });
    assert.ok(
      result.durationMs < 3000,
      "Dependency outage must not outlive bounded probe deadlines",
    );
    assert.equal(identity(), originalIdentity, "Dependency outage must not restart coordinator");
    rows.push({ phase, ...result });
  };
  check("healthy", 200);
  // Removing the real storage endpoint from the sole dependency network proves
  // actual disconnection independently of any pool/browser failure.
  docker(["network", "disconnect", network, storage]);
  try {
    check("storage-disconnected", 503);
  } finally {
    docker(["network", "connect", "--alias", "minio", network, storage]);
  }
  check("storage-recovered", 200);
  // SIGSTOP container freezes existing/new S3 sockets; readiness must abort a
  // silent response rather than hanging. The production deadline is unchanged.
  docker(["pause", storage]);
  try {
    check("storage-timeout", 503);
  } finally {
    docker(["unpause", storage]);
  }
  check("storage-timeout-recovered", 200);
  return {
    rows,
    coordinatorRestarted: false,
    s3ProbeDeadlineMs: 1000,
    productionNetworkIsolationPreserved: true,
  };
}
