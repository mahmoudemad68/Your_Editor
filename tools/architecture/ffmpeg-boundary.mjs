/** Lint rule: new production subprocess owners require an explicit reviewed exception. */
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// FFprobe sandbox and queue supervision do not authorize direct FFmpeg execution.
export const processOwners = new Set([
  "workers/media-worker/src/infrastructure/media-validator.ts",
  "workers/media-worker/src/infrastructure/child-job-supervisor.ts",
  "workers/media-worker/src/handlers/sample-handlers.ts",
  "workers/ai-worker/src/editagent_ai_worker/infrastructure/job_queue.py",
]);
export function boundaryViolations(source, file) {
  if (file.startsWith("packages/media-core/")) return [];
  if (file.endsWith(".c")) return /\b(?:execv|execve|system|popen)\s*\(/.test(source) ? [file] : [];
  if (file.endsWith(".py")) {
    return /\b(?:subprocess|create_subprocess_exec|create_subprocess_shell)\b/.test(source) &&
      !processOwners.has(file)
      ? [file]
      : [];
  }
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const failures = [];
  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /^(?:node:)?child_process$/.test(node.moduleSpecifier.text) &&
      !processOwners.has(file)
    )
      failures.push(file);
    if (
      ts.isCallExpression(node) &&
      /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|run)\b$/.test(
        node.expression.getText(ast),
      )
    ) {
      const first = node.arguments[0]?.getText(ast) ?? "";
      if (
        /ffmpeg/i.test(first) ||
        /(?:child_process|require\()/i.test(node.expression.getText(ast))
      )
        failures.push(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...new Set(failures)];
}
export function lintFfmpegBoundary(root = ".") {
  return checkRepository(root);
}
// Walk package/deployable roots: their src directories are one level below.
export function checkRepository(root = ".") {
  const failures = [];
  for (const group of ["apps", "workers", "packages"])
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      function walk(directory) {
        for (const child of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, child.name);
          if (child.isDirectory()) {
            if (
              ![
                "node_modules",
                "dist",
                ".venv",
                "tests",
                "fixtures",
                "scripts",
                "e2e",
                "walking-skeleton",
                ".next",
                "coverage",
              ].includes(child.name)
            )
              walk(path);
          } else if (/\.(ts|tsx|js|mjs|py|c)$/.test(child.name) && !/\.test\./.test(child.name))
            failures.push(...boundaryViolations(readFileSync(path, "utf8"), relative(root, path)));
        }
      }
      const directory = join(root, group, entry.name);
      try {
        walk(directory);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  return [...new Set(failures)];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkRepository();
  if (failures.length) {
    process.stderr.write(
      `Direct production process/FFmpeg boundary violations: ${failures.join(", ")}\n`,
    );
    process.exitCode = 1;
  }
}
