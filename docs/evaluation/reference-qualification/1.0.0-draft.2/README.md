# Reference protocol review — 1.0.0-draft.2

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

Draft.2 is an **intentional semantic revision** under the [Owner/Lead decision](https://github.com/mahmoudemad68/Your_Editor/pull/98#issuecomment-6487456998),
covering all three methodology observations together. Draft.1 at commit
`f1ff69d7e849f15a86a7d1fa42680fdc5c0dd43f` stays unchanged. The inventory records
previous exact artifact hashes and binds the new specification, protocol and schemas.
The specification's decision matrix identifies the delta. Formal protocol approval
and all reference resources remain pending; no human work or qualification is claimed.
Historical local reports remain hash-only and are not published or claimed inspected.

No media, raw annotation answers, transcript text, personnel identities, credentials,
held-file contents or private service logs are published. The synthetic interface
example in the specification is explicitly labelled and is not execution evidence.

## Remaining decisions

1. Approve the exact revised protocol after inspection. The three methodology
   decisions are recorded; reference scope, precise bytes and resource authority
   still require formal approval. Thresholds
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
const directory = "docs/evaluation/reference-qualification/1.0.0-draft.2";
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

## Integrated methodology disposition

Arabic scope is per source/speaker/variety/competence, with frozen reference-coverage
floors and separate EN_TO_AR/AR_TO_EN reports. UNKNOWN/insufficient scope is NOT_QUALIFIED.
Primary precision is pooled sum(TP)/(sum(TP)+sum(FP)), threshold>=0.85 from actual
production ASR, never macro averages or a human-transcript oracle. Report all required
subgroups without inheriting their verdicts from pooled performance; no holdout tuning.
Immutable A/B, pre-adjudication IAA and independent audio-rationale adjudication use
RESOLVED/UNKNOWN_UNRESOLVED/INSUFFICIENT_COVERAGE. Any affected unresolved disagreement
blocks qualification even if all scores/bounds pass. Review triggers are not collars.

The new schema definitions are documentation contracts tested with in-memory synthetic
records only. They do not constitute collected annotations or qualified people/data.

## Reproduce all integrated negative and synthetic decision controls

Run this JavaScript with the same Node/locked-dependency setup from the repository
root. It does not write any file, access media or contact a service. Scope and
adjudication examples are **SYNTHETIC_SOFTWARE_FIXTURE** structural records only,
not people, annotations or qualified scope claims. The code reports the actual
control counts; the committed validation report was generated by the same checks.

```javascript
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const root = process.cwd(),
  base = "docs/evaluation/reference-qualification/1.0.0-draft.2",
  dir = path.join(root, base),
  old = path.join(root, "docs/evaluation/reference-qualification/1.0.0-draft.1");
const Ajv = require(path.join(root, "node_modules/.pnpm/ajv@8.20.0/node_modules/ajv/dist/2020.js"));
const formats = require(
  path.join(root, "node_modules/.pnpm/ajv-formats@3.0.1_ajv@8.20.0/node_modules/ajv-formats"),
);
const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sha = (n) => digest(path.join(dir, n));
const ajv = new Ajv({ strict: true, allErrors: true });
formats(ajv);
const valid = {},
  positive = [];
for (const name of ["protocol", "evidence-inventory"]) {
  const schema = read(name + ".schema.json");
  assert(ajv.validateSchema(schema), JSON.stringify(ajv.errors));
  valid[name] = ajv.compile(schema);
  assert(valid[name](read(name + ".json")), JSON.stringify(valid[name].errors));
  positive.push({
    document: name + ".json",
    schema: name + ".schema.json",
    schemaMetaValidation: "PASS",
    documentValidation: "PASS",
    sha256: sha(name + ".json"),
    schemaSha256: sha(name + ".schema.json"),
  });
}
const schema = read("protocol.schema.json");
valid.scope = ajv.getSchema(schema.$id + "#/$defs/ArabicScopeRecord");
valid.outcome = ajv.getSchema(schema.$id + "#/$defs/AdjudicationOutcome");
const scope = {
  sourceSha256: "0".repeat(64),
  speakerRef: "synthetic-speaker",
  variety: "EGYPTIAN_ARABIC",
  otherSpecified: null,
  varietyEvidenceRef: "synthetic-not-human-evidence",
  competenceEvidenceRef: "synthetic-not-human-competence",
  independentlyAnnotated: true,
  coverage: {
    sourceGroups: 3,
    speakers: 3,
    clips: 3,
    positiveFiller: 10,
    positiveRepetition: 10,
    negativeFiller: 10,
    negativeRepetition: 10,
    declaredConditionsCovered: true,
  },
  qualificationClaim: "QUALIFIED_SCOPE",
};
const outcome = {
  resolutionStatus: "RESOLVED",
  affectedDimensions: ["BOUNDARY"],
  independentAdjudicator: true,
  audioBasedRationale: "synthetic rationale only; no human work",
  strictPrecision: 1,
  qualificationDisposition: "ELIGIBLE_FOR_SCORING",
};
assert(valid.scope(scope), JSON.stringify(valid.scope.errors));
assert(valid.outcome(outcome), JSON.stringify(valid.outcome.errors));
const fixtures = {
  protocol: read("protocol.json"),
  "evidence-inventory": read("evidence-inventory.json"),
  scope,
  outcome,
};
const negatives = [];
function reject(name, which, mutate) {
  const d = structuredClone(fixtures[which]);
  mutate(d);
  assert.equal(valid[which](d), false, name);
  negatives.push({ case: name, result: "REJECTED_AS_EXPECTED" });
}
reject("missing protocol version", "protocol", (d) => delete d.version);
reject("stale draft.1 identity", "protocol", (d) => (d.version = "1.0.0-draft.1"));
reject("claimed formal approval", "protocol", (d) => (d.formalProtocolApproval = "APPROVED"));
reject(
  "removal guard claimed enabled",
  "protocol",
  (d) => (d.us223.automaticNonemptyRemoval = "READY"),
);
reject(
  "lowered precision threshold",
  "protocol",
  (d) => (d.us203PrimaryMetric.precisionThreshold = 0.8),
);
reject("lowered CP2 threshold", "protocol", (d) => (d.cp2.silenceF1Threshold = 0.8));
reject("duplicate label", "protocol", (d) => (d.labels[0] = d.labels[1]));
reject("unexpected property", "protocol", (d) => (d.unexpectedField = true));
reject(
  "blanket Arabic qualification",
  "protocol",
  (d) => (d.arabicVarietyScope.blanketArabicDialectClaimAllowed = true),
);
reject(
  "unknown variety may be qualified",
  "protocol",
  (d) => (d.arabicVarietyScope.unknownMayBeQualified = true),
);
reject(
  "missing speaker competence reporting",
  "protocol",
  (d) =>
    (d.arabicVarietyScope.perSpeakerFields = d.arabicVarietyScope.perSpeakerFields.filter(
      (x) => x !== "competenceEvidenceRef",
    )),
);
reject(
  "missing AR_TO_EN direction",
  "protocol",
  (d) => (d.arabicVarietyScope.directions = ["EN_TO_AR"]),
);
reject(
  "claiming actual qualified varieties",
  "protocol",
  (d) => (d.arabicVarietyScope.actualVarietiesQualified = ["MSA"]),
);
reject(
  "post-performance scope exclusion",
  "protocol",
  (d) => (d.arabicVarietyScope.excludeAfterModelPerformanceAllowed = true),
);
reject(
  "scope floor changed after freeze",
  "protocol",
  (d) => (d.scopeSufficiencyPolicy.minimumsPerClaimedScope.independentHeldoutSpeakers = 0),
);
reject(
  "subgroup performance threshold added",
  "protocol",
  (d) => (d.scopeSufficiencyPolicy.extraSubgroupPrecisionRecallOrIaaThresholds = true),
);
reject(
  "macro averaging primary precision",
  "protocol",
  (d) => (d.us203PrimaryMetric.aggregation = "AVERAGE_LANGUAGE_PRECISIONS"),
);
reject(
  "human transcript oracle as primary input",
  "protocol",
  (d) => (d.us203PrimaryMetric.input = "human transcript only"),
);
reject(
  "pooled pass applied to subgroups",
  "protocol",
  (d) => (d.us203PrimaryMetric.pooledPassImpliesSubgroupPass = true),
);
reject(
  "zero denominator marked pass",
  "protocol",
  (d) => (d.us203PrimaryMetric.zeroDenominatorStatus = "PASS"),
);
reject(
  "missing Arabic-variety breakdown",
  "protocol",
  (d) =>
    (d.us203PrimaryMetric.requiredBreakdowns = d.us203PrimaryMetric.requiredBreakdowns.filter(
      (x) => x !== "ARABIC_VARIETY",
    )),
);
reject(
  "missing abstention reporting",
  "protocol",
  (d) =>
    (d.us203PrimaryMetric.requiredCountsAndRates =
      d.us203PrimaryMetric.requiredCountsAndRates.filter((x) => x !== "ABSTENTIONS")),
);
reject(
  "holdout tuning enabled",
  "protocol",
  (d) => (d.us203PrimaryMetric.holdoutTuningAllowed = true),
);
reject(
  "mutable independent A/B tracks",
  "protocol",
  (d) => (d.disagreementPolicy.immutableIndependentABTracks = false),
);
reject(
  "post-adjudication IAA substituted",
  "protocol",
  (d) => (d.disagreementPolicy.preAdjudicationIaaRequired = false),
);
reject(
  "adjudicator independence removed",
  "protocol",
  (d) => (d.disagreementPolicy.separateIndependentAdjudicatorRequired = false),
);
reject(
  "audio rationale omitted",
  "protocol",
  (d) => (d.disagreementPolicy.audioBasedRationaleRequired = false),
);
reject(
  "unknown tolerated because score passes",
  "protocol",
  (d) => (d.disagreementPolicy.blockEvenIfPointScoreAndBoundsPass = false),
);
reject(
  "uncertainty bounds unblock acceptance",
  "protocol",
  (d) => (d.disagreementPolicy.uncertaintyBoundsRole = "ALLOW_PASS_WITH_FAVORABLE_BOUNDARY"),
);
reject(
  "review triggers treated as collars",
  "protocol",
  (d) => (d.disagreementPolicy.reviewTriggersAreAcceptanceCollars = true),
);
reject(
  "population disagreement not blocking",
  "protocol",
  (d) =>
    (d.disagreementPolicy.blockingDimensions = d.disagreementPolicy.blockingDimensions.filter(
      (x) => x !== "POPULATION",
    )),
);
reject(
  "unknown resolution status omitted",
  "protocol",
  (d) =>
    (d.disagreementPolicy.statuses = d.disagreementPolicy.statuses.filter(
      (x) => x !== "UNKNOWN_UNRESOLVED",
    )),
);
reject(
  "invalid artifact digest",
  "evidence-inventory",
  (d) => (d.reviewArtifacts[0].sha256 = "g".repeat(64)),
);
reject("claimed reference readiness", "evidence-inventory", (d) => (d.status = "READY"));
reject(
  "unassigned human work claimed",
  "evidence-inventory",
  (d) => (d.availability.actualPeopleAssigned = 1),
);
reject("unsupported variety record", "scope", (d) => (d.variety = "ALL_ARABIC_DIALECTS"));
reject("OTHER_SPECIFIED without name", "scope", (d) => (d.variety = "OTHER_SPECIFIED"));
reject("UNKNOWN qualified", "scope", (d) => (d.variety = "UNKNOWN"));
reject("qualified scope without competence", "scope", (d) => (d.competenceEvidenceRef = null));
reject(
  "qualified scope without source variety evidence",
  "scope",
  (d) => (d.varietyEvidenceRef = null),
);
reject(
  "qualified scope without independent reference",
  "scope",
  (d) => (d.independentlyAnnotated = false),
);
for (const key of [
  "sourceGroups",
  "speakers",
  "clips",
  "positiveFiller",
  "positiveRepetition",
  "negativeFiller",
  "negativeRepetition",
])
  reject("qualified scope with insufficient " + key, "scope", (d) => (d.coverage[key] = 0));
reject(
  "qualified scope missing conditions",
  "scope",
  (d) => (d.coverage.declaredConditionsCovered = false),
);
reject("RESOLVED without audio rationale", "outcome", (d) => (d.audioBasedRationale = null));
reject(
  "UNKNOWN_UNRESOLVED allowed by precision1",
  "outcome",
  (d) => (d.resolutionStatus = "UNKNOWN_UNRESOLVED"),
);
reject(
  "INSUFFICIENT_COVERAGE counted as eligible",
  "outcome",
  (d) => (d.resolutionStatus = "INSUFFICIENT_COVERAGE"),
);
reject(
  "adjudication by nonindependent reviewer",
  "outcome",
  (d) => (d.independentAdjudicator = false),
);
const inv = read("evidence-inventory.json");
const bindings = (d) =>
  [...d.reviewArtifacts, ...d.reviewSchemas].every(
    (a) => path.basename(a.path) === a.path && sha(a.path) === a.sha256,
  );
assert(bindings(inv));
const wrong = structuredClone(inv);
wrong.reviewArtifacts[0].sha256 = "0".repeat(64);
assert(valid["evidence-inventory"](wrong));
assert.equal(bindings(wrong), false);
negatives.push({
  case: "well-formed incorrect digest",
  result: "SCHEMA_VALID_BUT_HASH_BINDING_REJECTED_AS_EXPECTED",
});
for (const [name, expected] of Object.entries(
  inv.methodologyRevision.previousPublishedArtifactHashes,
))
  assert.equal(digest(path.join(old, name)), expected);
const protocol = read("protocol.json");
assert.equal(protocol.revision.previousProtocolSha256, digest(path.join(old, "protocol.json")));
const behavioral = [];
for (const dimension of protocol.disagreementPolicy.blockingDimensions) {
  const d = {
    ...outcome,
    resolutionStatus: "UNKNOWN_UNRESOLVED",
    affectedDimensions: [dimension],
    qualificationDisposition: "BLOCKED_QUALIFICATION",
  };
  assert(valid.outcome(d));
  behavioral.push({
    case: "unresolved " + dimension + " remains blocked at strict precision1",
    result: "PASS",
  });
}
const sparse = {
  ...scope,
  variety: "UNKNOWN",
  otherSpecified: null,
  qualificationClaim: "NOT_QUALIFIED",
};
assert(valid.scope(sparse));
const insufficient = {
  ...outcome,
  resolutionStatus: "INSUFFICIENT_COVERAGE",
  qualificationDisposition: "NOT_QUALIFIED",
};
assert(valid.outcome(insufficient));
const groups = [
  { group: "EN", tp: 99, fp: 1 },
  { group: "AR", tp: 1, fp: 4 },
  { group: "MIXED", tp: 10, fp: 0 },
];
const tp = groups.reduce((n, g) => n + g.tp, 0),
  fp = groups.reduce((n, g) => n + g.fp, 0);
const pooled = tp / (tp + fp);
assert(pooled >= 0.85);
assert(groups[1].tp / (groups[1].tp + groups[1].fp) < 0.85);
assert.equal(protocol.us203PrimaryMetric.pooledPassImpliesSubgroupPass, false);
behavioral.push({
  case: "synthetic pooled pass does not certify AR subgroup",
  result: "PASS",
  tp,
  fp,
  pooledPrecision: pooled,
  arabicPrecision: 0.2,
});
behavioral.push({
  case: "zero predictions are undefined and NOT_PROVEN",
  result: "PASS",
  precision: null,
  status: protocol.us203PrimaryMetric.zeroDenominatorStatus,
});
const report = {
  schemaDialect: "https://json-schema.org/draft/2020-12/schema",
  scope:
    "Draft.2 review schemas and synthetic methodology decision controls only; no human qualification",
  validator: {
    name: "Ajv",
    version: "8.20.0",
    formatsVersion: "3.0.1",
    nodeVersion: process.version,
    strict: true,
    allErrors: true,
    networkUsed: false,
  },
  positiveValidations: positive,
  negativeControls: negatives,
  syntheticMethodologyControls: behavioral,
  allScopeAndAdjudicationRecordsSynthetic: true,
  crossFileShaBindings: "PASS",
  revision: {
    version: "1.0.0-draft.2",
    previousVersion: "1.0.0-draft.1",
    semanticChange: "EXPECTED_AUTHORIZED_METHODOLOGY_REVISION",
    authority: protocol.authority,
    priorPublishedArtifactHashesUnchanged: true,
  },
  specification: {
    path: "SPECIFICATION.md",
    sha256: sha("SPECIFICATION.md"),
    schemaValidation: "NOT_APPLICABLE_MARKDOWN",
  },
  formalProtocolApproval: "PENDING",
  referenceAvailability: "BLOCKED_REFERENCE_DATA",
  us309: "BLOCKED",
  humanQualification: "NOT_PERFORMED",
};
console.log(
  JSON.stringify({
    schemas: 2,
    documents: 2,
    negativeControls: negatives.length,
    syntheticMethodologyControls: behavioral.length,
    crossFileHashes: "PASS",
    priorDraft: "UNCHANGED",
    status: "BLOCKED_REFERENCE_DATA",
  }),
);
```
