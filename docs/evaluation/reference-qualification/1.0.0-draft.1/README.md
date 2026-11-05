# Reference protocol review — 1.0.0-draft.1

**Formal protocol approval: PENDING. Reference availability: BLOCKED_REFERENCE_DATA.**
US-309 / Issue96 remains blocked. This is a docs-only review publication for
[Issue97](https://github.com/mahmoudemad68/Your_Editor/issues/97#issuecomment-6485649471),
not an implementation, annotation assignment or qualification result.

## Review artifacts

- [Specification](SPECIFICATION.md): all four label definitions, boundaries,
  protection/adjudication, sampling/splits, dual-human IAA, US203 precision protocol,
  historical versus independent CP2 evaluation, duration rejection and acquisition plan.
- [Protocol](protocol.json): proposed machine-readable settings and restrictions.
- [SHA-bound evidence inventory](evidence-inventory.json): exact published artifact
  and schema hashes, public Git source identities, unchanged original-gold hashes,
  historical evidence limitations and remaining decisions.
- [Protocol schema](protocol.schema.json) and
  [inventory schema](evidence-inventory.schema.json): strict JSON Schema2020-12
  document schemas. These are not annotation/gold schemas or production contracts.
- [Validation report](validation-report.json): actual validator versions, positive
  validation, negative controls and cross-file SHA binding results.

The specification has only formatting and local-reference-pointer edits for this
review edition; the protocol has formatting changes only. The inventory is an
explicit public projection of the original local inventory. Original local artifacts
remain unchanged; all three original byte hashes are recorded in the inventory.
Formal review applies to the published bytes and their new hashes. Historical local
reports are identified as **hash-only, not published**; no inspection of their
unavailable contents is claimed. Public source files can be inspected at the pinned
base-main commit using the inventory paths/Git blob IDs.

No media, raw annotation answers, transcript text, personnel identities, credentials,
held-file contents or private service logs are published. The synthetic interface
example in the specification is explicitly labelled and is not execution evidence.

## Remaining decisions

1. Approve the exact protocol after artifact inspection: target/reference semantics,
   primary matching/aggregation, uncertainty and qualification scope. Thresholds
   remain precision>=0.85 and silence F1>=0.90; CP2 scoring remains zero-collar.
2. Designate two competent independent bilingual annotators, an independent
   adjudicator and held-out custodian with documented independence. Approve actual
   human time and a budget cap. The48–84 human hours and10–20 engineering hours
   are estimates, not an approved budget or vendor quote; nobody is assigned.
3. Authorize source licensing/privacy, approved local access and retention/deletion.
   External sharing, paid acquisition and new collection remain unauthorized.

Protected content winning over target duration is already decided by the Lead.
`TARGET_DURATION_UNACHIEVABLE` is the proposed future structured outcome; it does
not implement an endpoint or bypass the current nonempty-removal guard.

## Reproduce schema validation

Use the pinned Node22/pnpm10 workspace and frozen lockfile dependencies. Run the
following JavaScript from the repository root with Node. It uses already installed
Ajv8.20.0 and ajv-formats3.0.1; it performs no downloads or network requests.

```javascript
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Ajv = require("./node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js");
const formats = require("./node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.20.0/node_modules/ajv-formats");
const directory = "docs/evaluation/reference-qualification/1.0.0-draft.1";
const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
const digest = (name) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(directory, name)))
    .digest("hex");
const ajv = new Ajv({ strict: true, allErrors: true });
formats(ajv);
for (const name of ["protocol", "evidence-inventory"]) {
  const schema = read(`${name}.schema.json`);
  if (!ajv.validateSchema(schema)) throw new Error("Invalid document schema");
  const validate = ajv.compile(schema);
  if (!validate(read(`${name}.json`))) throw new Error(JSON.stringify(validate.errors));
}
const inventory = read("evidence-inventory.json");
for (const artifact of [...inventory.reviewArtifacts, ...inventory.reviewSchemas]) {
  if (path.basename(artifact.path) !== artifact.path) throw new Error("Invalid review path");
  if (digest(artifact.path) !== artifact.sha256) throw new Error("Artifact SHA mismatch");
}
console.log("SCHEMAS_AND_BOUND_ARTIFACTS_PASS");
```

Also check formatting with `pnpm exec prettier --check` on this directory. Schema
success confirms document structure and declared boundaries; hash checks bind the
exact documents. Neither proves label quality, formal approval, independent human
work or production acceptance. The retained validation report describes additional
negative controls; none mutates published inputs or changes production policies.

CP1 NOT_VERIFIED; CP2 NOT_MET; US203 precision NOT_QUALIFIED; Tiny Arabic
NOT_QUALIFIED; PLANNER_NOT_CONFIGURED. No Ready transition, merge, deployment,
live/paid provider, US203/US223 implementation or US309 PR is authorized here.
