import ts from "typescript";
import process from "node:process";
import console from "node:console";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Only prompt-bearing AST positions in first-party production TS/JS. UI copy,
// tests, generated clients, dependencies and local artifacts are never scanned.
export function inlinePromptFindings(source, file = "source.ts") {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true),
    findings = [];
  const promptName =
    /^(?:system|developer|user)?(?:Prompt|Instructions)$|^(?:system|developer|user)?prompt$/;
  function visit(node) {
    let value;
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
      node.name &&
      promptName.test(node.name.getText(ast))
    )
      value = node.initializer;
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(ast) === "content" &&
      ts.isObjectLiteralExpression(node.parent) &&
      node.parent.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          p.name.getText(ast) === "role" &&
          p.initializer &&
          ["system", "developer"].includes(p.initializer.text),
      )
    )
      value = node.initializer;
    if (
      value &&
      (ts.isStringLiteral(value) ||
        ts.isNoSubstitutionTemplateLiteral(value) ||
        ts.isTemplateExpression(value)) &&
      value.getText(ast).length > 160
    )
      findings.push(ast.getLineAndCharacterOfPosition(value.pos).line + 1);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return findings;
}
export function scanPromptSources(root) {
  const findings = [];
  function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (
          ![
            "node_modules",
            "dist",
            "dist-test",
            ".next",
            "coverage",
            "tests",
            "__tests__",
          ].includes(e.name)
        )
          walk(p);
      } else if (
        /\.[cm]?[jt]sx?$/.test(e.name) &&
        !/(?:\.test\.|\.spec\.|\.generated\.|\.d\.ts$)/.test(e.name)
      )
        for (const line of inlinePromptFindings(readFileSync(p, "utf8"), p))
          findings.push({ file: path.relative(root, p), line });
    }
  }
  for (const dir of ["packages/agent-core/src", "workers/agent-worker/src", "apps/api/src"])
    walk(path.join(root, dir));
  return findings;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = scanPromptSources(process.cwd());
  for (const f of findings) console.error(`Inline production prompt rejected: ${f.file}:${f.line}`);
  if (findings.length) process.exitCode = 1;
}
