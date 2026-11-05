/** Read-only deadlock diagnosis. This tool never grants admission or changes protection. */
import process from "node:process";
import console from "node:console";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, completePages } from "./pc100-source-verifier.mjs";

export async function inspectBootstrap(read) {
  const main = await read("branches/main");
  const protection = await read("branches/main/protection");
  const rules = await read("rules/branches/main");
  if (
    main.protected !== true ||
    !/^[a-f0-9]{40}$/.test(main.commit?.sha ?? "") ||
    !protection.enforce_admins?.enabled ||
    !Array.isArray(rules)
  )
    throw Error("BOOTSTRAP_PROTECTION_UNVERIFIABLE");
  const rulesets = [];
  for (const id of new Set(rules.map((r) => r.ruleset_id))) {
    if (!Number.isSafeInteger(id) || id <= 0) throw Error("BOOTSTRAP_PROTECTION_UNVERIFIABLE");
    const r = await read(`rulesets/${id}`);
    if (
      r.id !== id ||
      r.enforcement !== "active" ||
      !Array.isArray(r.bypass_actors) ||
      r.bypass_actors.length
    )
      throw Error("BOOTSTRAP_PROTECTION_UNVERIFIABLE");
    rulesets.push({ id: r.id, bypass_actors: r.bypass_actors });
  }
  const required = new Set([
    ...(protection.required_status_checks?.contexts ?? []),
    ...rules
      .filter((r) => r.type === "required_status_checks")
      .flatMap((r) => r.parameters.required_status_checks.map((c) => c.context)),
  ]);
  if (!required.has("ci") || !required.has("supply-chain-security"))
    throw Error("BOOTSTRAP_REQUIRED_CHECKS_UNVERIFIABLE");
  const pulls = [];
  for (const number of [103, 100]) {
    const p = await read(`pulls/${number}`);
    if (
      p.number !== number ||
      p.base.ref !== "main" ||
      ![p.head?.sha, p.base?.sha].every((s) => /^[a-f0-9]{40}$/.test(s ?? "")) ||
      (p.merge_commit_sha !== null && !/^[a-f0-9]{40}$/.test(p.merge_commit_sha ?? ""))
    )
      throw Error("BOOTSTRAP_PR_IDENTITY_UNVERIFIABLE");
    // A conflicted PR can legitimately have no test merge. Do not query a
    // null identity or substitute an old positive HEAD check in that case.
    const mergeAvailable = p.merge_commit_sha !== null;
    const checks = !mergeAvailable
      ? []
      : await completePages(
          read,
          `commits/${p.merge_commit_sha}/check-runs?filter=all`,
          "check_runs",
        );
    const headChecks = !mergeAvailable
      ? []
      : await completePages(read, `commits/${p.head.sha}/check-runs?filter=all`, "check_runs");
    const results = [...required].sort().map((name) => {
      // A test-merge check takes precedence; otherwise GitHub uses HEAD.
      const mergeChecks = checks.filter(
        (c) => c.name === name && c.head_sha === p.merge_commit_sha,
      );
      const associated = mergeChecks.length
        ? mergeChecks
        : headChecks.filter((c) => c.name === name && c.head_sha === p.head.sha);
      const rows = associated.filter((c) => c.app?.id === 15368).sort((a, b) => b.id - a.id);
      return {
        name,
        check: rows[0]?.id ?? null,
        head_sha: rows[0]?.head_sha ?? null,
        status: rows[0]?.status ?? "missing",
        conclusion: rows[0]?.conclusion ?? null,
      };
    });
    pulls.push({
      pr: number,
      H: p.head.sha,
      B: p.base.sha,
      M: p.merge_commit_sha,
      test_merge_available: mergeAvailable,
      on_current_base: p.base.sha === main.commit.sha,
      required: results,
    });
  }
  const finalMain = await read("branches/main");
  if (finalMain.protected !== true || finalMain.commit?.sha !== main.commit.sha)
    throw Error("BOOTSTRAP_BASE_DRIFT");
  const ready = pulls.every(
    (p) =>
      p.on_current_base &&
      p.required.every((c) => c.status === "completed" && c.conclusion === "success"),
  );
  return {
    schema: "pc100-bootstrap-preflight-v1",
    main: main.commit.sha,
    enforce_admins: true,
    rulesets,
    pulls,
    outcome: ready ? "REQUIRED_CHECKS_PASS_REVIEW_STILL_REQUIRED" : "BLOCKED_REQUIRED_CHECKS",
    // Route A may already be merged. Report current evidence, never ask for a
    // second prerequisite PR or treat old-base green checks as qualification.
    next_route: ready
      ? "INDEPENDENT_REVIEW_AND_OWNER_INSTALLATION_GATES"
      : "REVIEW_CURRENT_BASE_AND_REPORTED_REQUIRED_CHECKS",
    settings_mutation_authorized: false,
    candidate_admission_authorized: false,
    release_authorized: false,
    live_a6_enforced: false,
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw Error("BOOTSTRAP_ARGUMENTS_REJECTED");
    const result = await inspectBootstrap((route) =>
      api(route, process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.outcome === "BLOCKED_REQUIRED_CHECKS") process.exitCode = 1;
  } catch {
    console.error("BOOTSTRAP_INSPECTION_FAILED_CLOSED");
    process.exitCode = 1;
  }
}
