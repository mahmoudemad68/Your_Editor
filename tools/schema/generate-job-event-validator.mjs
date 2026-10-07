import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import process from "node:process";
import prettier from "prettier";
const require = createRequire(new URL("../../packages/job-queue/package.json", import.meta.url));
const Ajv = require("ajv/dist/2020.js");
const standalone = require("ajv/dist/standalone/index.js");
const schema = JSON.parse(
  await readFile(
    new URL("../../packages/schemas/src/job-event.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false, code: { source: true, esm: true } });
const validate = ajv.compile(schema);
// Browser CSP forbids runtime code generation. Compile the SAME canonical JSON
// schema at build time; generated code contains no eval/new Function.
const output = await prettier.format(
  `/* eslint-disable -- Generated schema validator. Do not edit. */\n${standalone(ajv, validate)}\n`,
  { parser: "babel", printWidth: 100 },
);
const target = fileURLToPath(
  new URL("../../packages/schemas/src/job-event-validator.generated.js", import.meta.url),
);
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== output)
    throw new Error(
      "Job event validator is stale. Run node tools/schema/generate-job-event-validator.mjs.",
    );
} else await writeFile(target, output);
