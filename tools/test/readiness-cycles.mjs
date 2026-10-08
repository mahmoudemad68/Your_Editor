/** Disposable Compose proof only: no deployment, configuration or enablement. */
import console from "node:console";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { command } from "./compose-build.mjs";
export async function verifyReadinessCycles(root, env) {
  const services = ["api", "media-worker"];
  const nativeHealth = new Map(
    services.map((service) => {
      const id = spawnSync("docker", ["compose", "ps", "-q", service], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(id.status, 0);
      const inspected = spawnSync(
        "docker",
        ["inspect", "--format", "{{json .Config.Healthcheck}}", id.stdout.trim()],
        { cwd: root, env, encoding: "utf8", timeout: 15000 },
      );
      assert.equal(inspected.status, 0);
      const healthcheck = JSON.parse(inspected.stdout);
      assert.ok(healthcheck.Test.join(" ").includes("/ready"));
      assert.equal(healthcheck.Interval, 5_000_000_000);
      return [service, { healthcheckIntervalMs: healthcheck.Interval / 1_000_000 }];
    }),
  );
  await Promise.all(
    services.map((service) =>
      command(
        "docker",
        [
          "compose",
          "exec",
          "-T",
          service,
          "node",
          "--input-type=module",
          "-e",
          `const port=${service === "api" ? 3001 : 3200};
     let probes=0;
     for(let i=0;i<61;i++) {
       if(i>=31) await new Promise(resolve=>setTimeout(resolve,5000));
       const ready=await fetch('http://127.0.0.1:'+port+'/ready',{signal:AbortSignal.timeout(3000)});
       if(ready.status!==200) throw new Error('Readiness regression');
       await ready.arrayBuffer(); probes++;
     }
     const health=await fetch('http://127.0.0.1:'+port+'/health',{signal:AbortSignal.timeout(3000)});
     if(health.status!==200) throw new Error('Liveness regression');
     await health.arrayBuffer();
     console.log('B2_COMPOSE_PROBES',JSON.stringify({service:'${service}',probes,scheduledWindowMs:150000}));`,
        ],
        { cwd: root, env },
      ),
    ),
  );
  const evidence = services.map((service) => {
    const result = spawnSync("docker", ["compose", "logs", "--no-color", service], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(result.status, 0, "Compose diagnostics must be readable");
    const logs = (result.stdout ?? "") + (result.stderr ?? "");
    const warnings = (logs.match(/MaxListenersExceededWarning/g) ?? []).length;
    assert.equal(warnings, 0, `${service} readiness must not accumulate listeners`);
    return {
      service,
      probes: 61,
      warnings,
      scheduledWindowMs: 150000,
      ...nativeHealth.get(service),
    };
  });
  console.log("B2_COMPOSE_READINESS_EVIDENCE", JSON.stringify(evidence));
  return evidence;
}
