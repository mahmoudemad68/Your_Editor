/** Admission software controls; synthetic inputs are not runtime qualification. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  parseCommitMetadata,
  FILTER_PROFILE,
  validateFilterAttempt,
  runBoundedFilterExperiment,
  OCI_PROFILE,
  runOCITool,
  validateOCIAttempt,
  runBoundedOCIExperiment,
  ociZipBound,
  transferBudgetReport,
  reportAndEnforceTransfer,
  REPORT_FILES,
  compressArchive,
  identityEvidence,
  PR_IDENTITY_API,
  readIdentityPr,
  validateIdentityApiVersion,
  reconcileIdentity,
  validateIdentity,
  validateProducer,
  validateArtifact,
  validateScans,
  validateCheck,
  reviewedBinding,
  POLICY_FILES,
  decompress,
  sha256,
  unpackVerifiedZip,
  REPOSITORY_ID,
  BASE,
  SERVICES,
} from "../../tools/test/load-qualified-storage.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const H = "a".repeat(40),
  M = "b".repeat(40),
  T = "c".repeat(40);
const context = { H, B: BASE, M, TH: T, TM: T };
const env = {
  GITHUB_WORKFLOW: "CI",
  GITHUB_RUN_ID: "20",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_SHA: M,
  GITHUB_REF: "refs/pull/100/merge",
};
function identity() {
  return {
    pr: {
      number: 100,
      state: "open",
      draft: true,
      merged: false,
      merge_commit_sha: M,
      head: { sha: H, repo: { id: REPOSITORY_ID } },
      base: { sha: BASE, repo: { id: REPOSITORY_ID } },
    },
    head: { sha: H, tree: { sha: T } },
    merge: { sha: M, tree: { sha: T }, parents: [{ sha: BASE }, { sha: H }] },
    native: {
      id: 20,
      run_attempt: 1,
      workflow_id: 370458734,
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      head_sha: H,
      repository: { id: REPOSITORY_ID },
      head_repository: { id: REPOSITORY_ID },
      pull_requests: [{ number: 100, head: { sha: H }, base: { sha: BASE } }],
    },
  };
}
const checkIdentity = (f, c = context, e = env) =>
  validateIdentity(c, f.pr, f.head, f.merge, f.native, e);
test("native PR H and original merge/check identity are accepted only together", () =>
  checkIdentity(identity()));
for (const [name, mutate] of [
  ["wrong repo", (x) => x.pr.head.repo.id++],
  ["wrong PR", (x) => x.pr.number++],
  ["head changed", (x) => (x.pr.head.sha = M)],
  ["base changed", (x) => (x.pr.base.sha = H)],
  ["merge changed", (x) => (x.pr.merge_commit_sha = H)],
  ["merge tree changed", (x) => (x.merge.tree.sha = H)],
  ["parents swapped", (x) => x.merge.parents.reverse()],
  ["missing parent", (x) => x.merge.parents.pop()],
  ["workflow replaced", (x) => x.native.workflow_id++],
  ["workflow path replaced", (x) => (x.native.path = "fake.yml")],
  ["dispatch substituted", (x) => (x.native.event = "workflow_dispatch")],
  ["fork", (x) => x.native.head_repository.id++],
  ["attempt drift", (x) => x.native.run_attempt++],
  ["native run drift", (x) => x.native.id++],
  ["PR association missing", (x) => (x.native.pull_requests = [])],
  ["closed", (x) => (x.pr.state = "closed")],
])
  test(`admission rejects ${name}`, () => {
    const f = identity();
    mutate(f);
    assert.throws(() => checkIdentity(f));
  });
test("moving refs and merge/head tree differences do not inherit proof", () => {
  assert.throws(() => checkIdentity(identity(), { ...context, TM: H }));
  assert.throws(() =>
    checkIdentity(identity(), context, { ...env, GITHUB_REF: "refs/heads/main" }),
  );
  assert.throws(() => checkIdentity(identity(), context, { ...env, GITHUB_SHA: H }));
});
function producer() {
  const source = {
    id: 10,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    workflow_id: 374068707,
    path: ".github/workflows/supply-chain.yml",
    head_sha: H,
    repository: { id: REPOSITORY_ID },
    head_repository: { id: REPOSITORY_ID },
    pull_requests: [{ number: 100, head: { sha: H }, base: { sha: BASE } }],
  };
  const jobs = ["dependencies", "supply-chain-security", ...SERVICES.map((s) => `image ${s}`)].map(
    (name) => ({ name, run_attempt: 1, status: "completed", conclusion: "success", steps: [] }),
  );
  jobs.find((j) => j.name === "image seaweedfs").steps = [
    "Fixed module reproducibility and zero HIGH gate",
    "Bounded RSA JWK and Brotli controls",
    "Upload qualified candidate",
    "Seal qualified candidate upload",
    "Upload candidate seal",
  ].map((name) => ({ name, status: "completed", conclusion: "success" }));
  return { source, jobs };
}
test("entire completed Supply and all eleven scans are required", () => {
  const p = producer();
  validateProducer(p.source, p.jobs, context);
});
for (const [name, mutate, code] of [
  ["producer running", (x) => (x.source.status = "in_progress"), "PRODUCER_NOT_YET_COMPLETE"],
  ["whole producer failed", (x) => (x.source.conclusion = "failure"), "PRODUCER_FAILED"],
  ["whole producer cancelled", (x) => (x.source.conclusion = "cancelled"), "PRODUCER_FAILED"],
  [
    "image green aggregate red",
    (x) => (x.jobs.find((j) => j.name === "supply-chain-security").conclusion = "failure"),
    "PRODUCER_REQUIRED_JOB_FAILED",
  ],
  ["scan skipped", (x) => (x.jobs[2].conclusion = "skipped"), "PRODUCER_REQUIRED_JOB_FAILED"],
  ["scan missing", (x) => x.jobs.pop(), "PRODUCER_REQUIRED_JOB_FAILED"],
  ["mixed attempts", (x) => x.jobs[1].run_attempt++, "PRODUCER_REQUIRED_JOB_FAILED"],
  [
    "module gate skipped",
    (x) => (x.jobs.find((j) => j.name === "image seaweedfs").steps[0].conclusion = "skipped"),
    "CANDIDATE_GATE_FAILED",
  ],
  ["forged source workflow", (x) => x.source.workflow_id++, "PRODUCER_WORKFLOW_DRIFT"],
])
  test(name, () => {
    const p = producer();
    mutate(p);
    assert.throws(
      () => validateProducer(p.source, p.jobs, context),
      (e) => e.code === code,
    );
  });
test("only actual incomplete producer state is a retryable prerequisite", () => {
  for (const state of ["failure", "cancelled", "timed_out", "skipped", "neutral"]) {
    const p = producer();
    p.source.conclusion = state;
    assert.throws(
      () => validateProducer(p.source, p.jobs, context),
      (e) => e.code === "PRODUCER_FAILED",
    );
  }
});
function artifact() {
  const start = Date.now() - 60000;
  return {
    value: {
      id: 30,
      workflow_run: { id: 10, head_sha: H, head_repository_id: REPOSITORY_ID },
      expired: false,
      created_at: new Date(start + 1000).toISOString(),
      expires_at: new Date(start + 86400000).toISOString(),
      size_in_bytes: 1000,
      digest: `sha256:${"a".repeat(64)}`,
    },
    step: {
      started_at: new Date(start).toISOString(),
      completed_at: new Date(start + 5000).toISOString(),
    },
  };
}
test("artifact belongs to the controlled upload, attempt time and bounded retention", () => {
  const a = artifact();
  validateArtifact(a.value, producer().source, 30, 2000, a.step);
});
for (const [name, mutate] of [
  ["expired", (x) => (x.expired = true)],
  ["wrong run", (x) => x.workflow_run.id++],
  ["cross-head", (x) => (x.workflow_run.head_sha = M)],
  ["wrong artifact", (x) => x.id++],
  ["oversized", (x) => (x.size_in_bytes = 2001)],
  ["empty", (x) => (x.size_in_bytes = 0)],
  ["missing digest", (x) => delete x.digest],
  ["stale attempt", (x) => (x.created_at = "2020-01-01T00:00:00Z")],
  ["long retention", (x) => (x.expires_at = new Date(Date.now() + 3 * 86400000).toISOString())],
])
  test(`artifact ${name} fails closed`, () => {
    const a = artifact();
    mutate(a.value);
    assert.throws(() => validateArtifact(a.value, producer().source, 30, 2000, a.step));
  });
test("zero HIGH/CRITICAL is separate from unchanged global scan policy", () => {
  const sbom = { spdxVersion: "SPDX-2.3", packages: [{}] };
  validateScans({ SchemaVersion: 2, Results: [{ Vulnerabilities: [{ Severity: "LOW" }] }] }, sbom);
  for (const Severity of ["HIGH", "CRITICAL"])
    assert.throws(() =>
      validateScans({ SchemaVersion: 2, Results: [{ Vulnerabilities: [{ Severity }] }] }, sbom),
    );
  assert.throws(() => validateScans({}, sbom));
  assert.throws(() => validateScans({ SchemaVersion: 2, Results: [] }, sbom));
});

const python = process.env.TEST_PYTHON ?? "python3";
async function temporary(body) {
  const parent = path.join(root, ".local/issue99");
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "archive-unit-"));
  try {
    await body(dir);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(parent) + path.sep));
    await rm(dir, { recursive: true, force: true });
  }
}
function zip(entries) {
  return execFileSync(
    python,
    [
      "-c",
      `
import zipfile,io,json,sys,stat
b=io.BytesIO()
with zipfile.ZipFile(b,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for e in json.loads(sys.argv[1]):
  info=zipfile.ZipInfo(e['name']);info.compress_type=zipfile.ZIP_DEFLATED
  if e.get('link'): info.external_attr=(stat.S_IFLNK|0o777)<<16
  z.writestr(info,e.get('body','ok'))
sys.stdout.buffer.write(b.getvalue())
`,
      JSON.stringify(entries),
    ],
    { maxBuffer: 1048576 },
  );
}
test("real ZIP bytes are verified and extracted without Docker or network", async () =>
  temporary(async (dir) => {
    const b = zip([{ name: "seal.json", body: '{"test":"synthetic"}' }]);
    await unpackVerifiedZip(
      b,
      `sha256:${sha256(b)}`,
      path.join(dir, "out"),
      ["seal.json"],
      4096,
      python,
    );
    assert.equal(await readFile(path.join(dir, "out/seal.json"), "utf8"), '{"test":"synthetic"}');
  }));
for (const [name, entries, allowed] of [
  ["traversal", [{ name: "../outside" }], ["seal.json"]],
  ["absolute", [{ name: "/outside" }], ["seal.json"]],
  ["duplicate", [{ name: "seal.json" }, { name: "seal.json" }], ["seal.json"]],
  ["symlink", [{ name: "seal.json", link: true }], ["seal.json"]],
  ["extra member", [{ name: "seal.json" }, { name: "extra" }], ["seal.json"]],
  ["excess expansion", [{ name: "seal.json", body: "x".repeat(8192) }], ["seal.json"]],
])
  test(`real ZIP rejects ${name}`, async () =>
    temporary(async (dir) => {
      const b = zip(entries);
      await assert.rejects(
        unpackVerifiedZip(b, `sha256:${sha256(b)}`, path.join(dir, "out"), allowed, 4096, python),
      );
    }));
test("digest mismatch never reaches ZIP extraction", async () =>
  temporary(async (dir) => {
    const b = zip([{ name: "seal.json" }]);
    await assert.rejects(
      unpackVerifiedZip(
        b,
        `sha256:${"0".repeat(64)}`,
        path.join(dir, "out"),
        ["seal.json"],
        4096,
        python,
      ),
      (e) => e.code === "GITHUB_ARCHIVE_DIGEST_MISMATCH",
    );
  }));

test("offline build, clean runtime and native PR failure propagation remain explicit", async () => {
  const read = (f) => readFile(path.join(root, f), "utf8");
  const dockerfile = await read("infra/seaweedfs/Dockerfile");
  assert.match(dockerfile, /RUN --network=none sh \/build\/build-weed.sh compile/);
  assert.match(dockerfile, /FROM scratch AS runtime/);
  assert.match(dockerfile, /COPY --from=runtime-files \/ \//);
  const build = await read("infra/seaweedfs/build-weed.sh");
  assert.match(build, /cmp \/out\/weed \/out\/weed.second/);
  assert.match(build, /sha256sum -c -/);
  assert.match(
    build.split("compile)\n")[0],
    /go mod download -json github\.com\/xyproto\/randomstring@v1\.0\.5/,
  );
  assert.equal(build.includes("go mod download all"), false);
  assert.match(build, /\/build\/check existing/);
  assert.match(build, /compile\)\n {2}cd \/build\/source\n {2}\/build\/check controls/);
  for (const name of [
    "unknown-module",
    "unexpected-checksum",
    "dependency-graph-drift",
    "unexpected-replacement",
    "unknown-test-download",
    "test-checksum-drift",
    "missing-original-test-checksum",
    "original-test-graph-drift",
    "missing-dependency-archive",
    "missing-security-module-archive",
    "attempted-online-compilation",
  ])
    assert.ok(build.includes('"' + name + '"'), name);

  assert.equal(/go get -u|go mod tidy|GOSUMDB=off|fips140=off/.test(build), false);
  const ci = await read(".github/workflows/ci.yml"),
    walking = await read(".github/workflows/e2e.yml");
  assert.match(ci, /pull_request:/);
  assert.match(walking, /pull_request:/);
  assert.match(ci, /needs: \[storage-admission, repository, real-asr, seaweedfs-product\]/);
  assert.match(ci, /test "\$ADMISSION_RESULT" = success/);
  assert.match(walking, /run: test "\$ADMISSION_RESULT" = success/);
  assert.equal(/workflow_run:|pull_request_target:/.test(ci + walking), false);
  assert.equal(walking.split("  walking-skeleton:")[1].includes("actions: read"), false);
  assert.match(walking, /artifact-ids: \$\{\{ needs.storage-admission.outputs.promoted_id \}\}/);
});

test("unknown producer states are non-retryable failures", () => {
  for (const status of [undefined, "", "forged-success", "skipped"]) {
    const p = producer();
    p.source.status = status;
    assert.throws(
      () => validateProducer(p.source, p.jobs, context),
      (e) => e.code === "PRODUCER_STATE_INVALID",
    );
  }
});
test("genuine check names, App, PR, SHA, suite and successful completion are all mandatory", () => {
  const check = {
    name: "supply-chain-security",
    app: { id: 15368 },
    head_sha: H,
    check_suite: { id: 40 },
    pull_requests: [{ number: 100 }],
    status: "completed",
    conclusion: "success",
  };
  validateCheck(check, context, 40, "supply-chain-security");
  for (const mutation of [
    (v) => v.app.id++,
    (v) => (v.name = "ci"),
    (v) => v.check_suite.id++,
    (v) => (v.head_sha = M),
    (v) => (v.pull_requests = []),
    (v) => (v.conclusion = "skipped"),
    (v) => (v.conclusion = "neutral"),
    (v) => (v.conclusion = "failure"),
    (v) => (v.status = "in_progress"),
  ]) {
    const v = globalThis.structuredClone(check);
    mutation(v);
    assert.throws(() => validateCheck(v, context, 40, "supply-chain-security"));
  }
});
function reviewFixture(change = {}) {
  const binding = {
    decision: "APPROVED",
    repository_id: REPOSITORY_ID,
    pr: 100,
    H,
    B: BASE,
    TH: T,
    files: Object.fromEntries(POLICY_FILES.map((f) => [f, "a".repeat(64)])),
    ...change,
  };
  return {
    id: 99,
    user: { login: "mahmoudemad68" },
    author_association: "OWNER",
    body: "```seaweedfs-policy-v1\n" + JSON.stringify(binding) + "\n```",
  };
}
test("synthetic review selector controls do not mint an actual policy approval", () => {
  const c = reviewFixture();
  assert.equal(reviewedBinding([c], context).comment_id, 99);
  for (const value of [
    [],
    [reviewFixture({ decision: "REVIEW_REQUIRED_NOT_APPROVED" })],
    [reviewFixture({ H: M })],
    [reviewFixture({ B: H })],
    [reviewFixture({ pr: 101 })],
    [reviewFixture({ TH: H })],
    [reviewFixture({ files: {} })],
    [reviewFixture({ repository_id: 1 })],
    [c, c],
    [{ ...c, user: { login: "untrusted" } }],
    [{ ...c, author_association: "CONTRIBUTOR" }],
  ])
    assert.throws(() => reviewedBinding(value, context));
});
function compressed(body) {
  return execFileSync(python, [
    "-c",
    "import lzma,sys;sys.stdout.buffer.write(lzma.compress(sys.argv[1].encode()))",
    body,
  ]);
}
test("bounded real XZ accepts complete bytes and rejects corruption, truncation, trailing streams and expansion", async () =>
  temporary(async (dir) => {
    const value = compressed("synthetic image transport control");
    const source = path.join(dir, "valid.xz");
    await writeFile(source, value);
    await decompress(source, path.join(dir, "valid.tar"), python);
    assert.equal(
      await readFile(path.join(dir, "valid.tar"), "utf8"),
      "synthetic image transport control",
    );
    for (const [name, bytes, limit] of [
      ["corrupt", Buffer.from("invalid xz"), 4096],
      ["truncated", value.subarray(0, value.length - 3), 4096],
      ["trailing", Buffer.concat([value, Buffer.from("extra")]), 4096],
      ["second-stream", Buffer.concat([value, value]), 4096],
      ["expansion", compressed("x".repeat(8192)), 4096],
    ]) {
      const file = path.join(dir, name + ".xz");
      await writeFile(file, bytes);
      await assert.rejects(decompress(file, path.join(dir, name + ".tar"), python, limit));
    }
  }));

test("real Docker archive inventory rejects layer, ELF, compiler, module and filesystem tampering before any binary execution", async () =>
  temporary(async (dir) => {
    const script = await readFile(path.join(root, "infra/seaweedfs/verify-image.sh"), "utf8");
    const inventory = /python3 - "\$archive" "\$work" "\$root" <<'PY'\r?\n([\s\S]*?)\r?\nPY/.exec(
      script,
    )?.[1];
    assert.ok(inventory);
    const generator = `
import io,tarfile,json,hashlib,sys,gzip
from pathlib import Path
p=Path(sys.argv[1]); variant=sys.argv[2]; root=p/'repo'; work=p/'evidence'
(root/'infra/seaweedfs').mkdir(parents=True);work.mkdir()
sha=lambda b:hashlib.sha256(b).hexdigest()
wrapper=b'#!/bin/sh\\npublic synthetic wrapper\\n'
(root/'infra/seaweedfs/docker-entrypoint.sh').write_bytes(wrapper)
mods={'github.com/go-jose/go-jose/v4':{'version':'v4.1.6','go_sum_lines':['jose-new','jose-mod-new']},'github.com/andybalholm/brotli':{'version':'v1.2.7','go_sum_lines':['brotli-new','brotli-mod-new']}}
old={'github.com/go-jose/go-jose/v4':'v4.1.5','github.com/andybalholm/brotli':'v1.2.6'}
oldmod=('module synthetic\\n'+''.join(n+' '+old[n]+'\\n' for n in mods)).encode()
newmod=('module synthetic\\n'+''.join(n+' '+mods[n]['version']+'\\n' for n in mods)).encode()
oldsum=b'unchanged-old-checksum\\n'; newsum=oldsum+b''.join((line+'\\n').encode() for v in mods.values() for line in v['go_sum_lines'])
lock={'modules':mods,'original_versions':old,'source':{'go.mod_sha256':sha(oldmod),'go.sum_sha256':sha(oldsum)}}
(root/'infra/seaweedfs/security-build.lock.json').write_text(json.dumps(lock))
oldelf=b'\\x7fELFold'; newelf=b'\\x7fELFnew'
base={'usr/bin/weed':oldelf,'usr/bin/weed-volume':b'unchanged-rust-volume','usr/bin/weed-worker':b'unchanged-rust-worker','lib/apk/db/installed':b'P:brotli-libs\\nV:1.2.1-r0\\n\\n','entrypoint.sh':b'unchanged-native-entrypoint'}
prefix='usr/share/editagent-seaweedfs/'
candidate={**base,'usr/bin/weed':newelf,'usr/local/bin/editagent-entrypoint.sh':wrapper,prefix+'security-build.lock.json':json.dumps(lock).encode(),prefix+'go.mod':newmod,prefix+'go.sum':newsum,prefix+'module-graph.json':b'{}',prefix+'go-version-m.txt':b'fake: go1.26.10\\n',prefix+'elf-sha256.txt':(sha(newelf)+'  first\\n'+sha(newelf)+'  second\\n').encode()}
for name in ['seaweedfs','go','go-jose','go-brotli']: candidate[prefix+'LICENSE.'+name+'.txt']=b'public synthetic license fixture'
for label in ['one','two']: candidate[prefix+'build-'+label+'.json']=json.dumps({'elf_sha256':sha(newelf),'cache_initially_empty':True,'wall_seconds':1}).encode()
if variant=='old-elf': candidate['hidden-old-elf']=oldelf
if variant=='compiler': candidate['usr/local/go/bin/go']=b'compiler'
if variant=='module': candidate[prefix+'go.mod']=newmod.replace(b'v4.1.6',b'v4.1.7')
if variant=='elf-proof': candidate[prefix+'elf-sha256.txt']=b'0 first\\n0 second\\n'
def archive(name,files,custom):
 b=io.BytesIO()
 with tarfile.open(fileobj=b,mode='w') as t:
  for path,data in files.items():
   m=tarfile.TarInfo(path);m.mode=0o755;m.size=len(data)
   if custom and variant=='mode' and path=='usr/bin/weed-volume': m.mode=0o777
   t.addfile(m,io.BytesIO(data))
  if custom and variant=='duplicate':
   m=tarfile.TarInfo('usr/bin/weed');m.size=len(newelf);t.addfile(m,io.BytesIO(newelf))
  if custom and variant=='traversal':
   m=tarfile.TarInfo('../escape');t.addfile(m)
  if custom and variant=='symlink':
   m=tarfile.TarInfo(prefix+'outside');m.type=tarfile.SYMTYPE;m.linkname='../../../../outside';t.addfile(m)
 layer=b.getvalue()
 if custom and variant=='expansion':
  m=tarfile.TarInfo('oversized');m.size=512*1024**2+1;layer=m.tobuf()+b'\\0'*1024
 cfg={'architecture':'amd64','os':'linux','rootfs':{'diff_ids':['sha256:'+('0'*64 if custom and variant=='layer' else sha(layer))]},'config':{'Cmd':['mini'],'Env':['PATH=/bin'],'WorkingDir':'/data','Volumes':{'/data':{}},'ExposedPorts':{'8333/tcp':{}},'User':'','Entrypoint':['/usr/local/bin/editagent-entrypoint.sh'] if custom else ['/entrypoint.sh'],'Labels':{'org.opencontainers.image.version':'4.51-editagent-sec1'}}}
 config=json.dumps(cfg).encode(); config_path='config.json';layer_path='layer.tar';extra=[]
 if custom and variant.startswith('oci'):
  layer=gzip.compress(layer,mtime=0);layer_path='blobs/sha256/'+sha(layer);config_path='blobs/sha256/'+sha(config)
  leaf={'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':'sha256:'+('0'*64 if variant=='oci-config' else sha(config)),'size':len(config)},'layers':[{'mediaType':'application/vnd.oci.image.layer.v1.tar+gzip','digest':'sha256:'+sha(layer),'size':len(layer)+(1 if variant=='oci-size' else 0)}]}
  leaf_bytes=json.dumps(leaf).encode();descriptor={'mediaType':leaf['mediaType'],'digest':'sha256:'+sha(leaf_bytes),'size':len(leaf_bytes)}
  extra=[('oci-layout',b'{"imageLayoutVersion":"1.0.0"}'),('index.json',json.dumps({'schemaVersion':2,'manifests':[descriptor,descriptor] if variant=='oci-ambiguous' else [descriptor]}).encode()),('blobs/sha256/'+sha(leaf_bytes),leaf_bytes)]
 manifest=json.dumps([{'Config':config_path,'Layers':[layer_path]}]).encode()
 with tarfile.open(work/name,'w') as t:
  for n,data in [('manifest.json',manifest),(config_path,config),(layer_path,layer)]+extra:
   m=tarfile.TarInfo(n);m.size=len(data);t.addfile(m,io.BytesIO(data))
archive('donor.tar',base,False);archive('candidate-input.tar',candidate,True)
`;
    for (const variant of [
      "valid",
      "oci-valid",
      "oci-config",
      "oci-size",
      "oci-ambiguous",
      "layer",
      "old-elf",
      "compiler",
      "module",
      "elf-proof",
      "mode",
      "duplicate",
      "traversal",
      "symlink",
      "expansion",
    ]) {
      const fixture = path.join(dir, variant);
      await mkdir(fixture);
      execFileSync(python, ["-c", generator, fixture, variant]);
      const check = () =>
        execFileSync(
          python,
          [
            "-c",
            inventory,
            path.join(fixture, "evidence/candidate-input.tar"),
            path.join(fixture, "evidence"),
            path.join(fixture, "repo"),
          ],
          { encoding: "utf8", stdio: "pipe" },
        );
      if (["valid", "oci-valid"].includes(variant)) assert.doesNotThrow(check);
      else assert.throws(check, variant);
    }
  }));

test("shallow H metadata is permitted while original M still requires both exact parents", () => {
  const f = identity();
  f.head = parseCommitMetadata(`${H}\n${T}\n\n`);
  f.merge = parseCommitMetadata(`${M}\n${T}\n${BASE} ${H}\n`);
  assert.deepEqual(f.head.parents, []);
  assert.doesNotThrow(() => checkIdentity(f));
  f.merge = parseCommitMetadata(`${M}\n${T}\n\n`);
  assert.throws(() => checkIdentity(f), /MERGE_PARENT_DRIFT/);
});

function reconciliationInput() {
  const f = identity();
  f.native.check_suite_id = 40;
  return {
    context,
    headCommit: f.head,
    mergeCommit: f.merge,
    checkout: f.merge,
    nativeRun: f.native,
    env,
    suite: { app: { id: 15368 }, head_sha: H, pull_requests: [{ number: 100 }] },
  };
}
async function reconciliation(prs, input = reconciliationInput()) {
  const snapshots = [],
    pauses = [];
  let reads = 0;
  const task = reconcileIdentity(
    input,
    async () => ({
      pr: prs[Math.min(reads++, prs.length - 1)],
      correlation: {
        request_id: "AB12:CD34",
        request_started_at: "2026-10-29T16:00:00.000Z",
        received_at: "2026-10-29T16:00:00.001Z",
        date: "Thu, 29 Oct 2026 16:00:00 GMT",
        status: 200,
        refresh: true,
      },
    }),
    async (ms) => {
      pauses.push(ms);
    },
    async (value) => {
      snapshots.push(value);
    },
  );
  return { task, snapshots, pauses, reads: () => reads };
}
function incomplete() {
  return { ...identity().pr, merge_commit_sha: null, mergeable: null, mergeable_state: "unknown" };
}
test("exact identity needs no refresh and records safe API correlation", async () => {
  const r = await reconciliation([identity().pr]);
  await r.task;
  assert.equal(r.reads(), 1);
  assert.deepEqual(r.pauses, []);
  assert.equal(r.snapshots[0].outcome, "IDENTITY_CONFIRMED");
  assert.equal(r.snapshots[0].api.request_id, "AB12:CD34");
  assert.equal(r.snapshots[0].api.date, "2026-10-29T16:00:00.000Z");
});
test("incomplete merge computation may reconcile only to the immutable original M", async () => {
  const r = await reconciliation([incomplete(), incomplete(), identity().pr]);
  await r.task;
  assert.equal(r.reads(), 3);
  assert.deepEqual(r.pauses, [500, 500]);
  assert.deepEqual(
    r.snapshots.map((s) => s.outcome),
    [
      "PR_MERGE_METADATA_INCOMPLETE_REFRESH",
      "PR_MERGE_METADATA_INCOMPLETE_REFRESH",
      "IDENTITY_CONFIRMED",
    ],
  );
});
test("unresolved metadata exhausts exactly three reads and remains non-retryable drift", async () => {
  const r = await reconciliation([incomplete()]);
  await assert.rejects(r.task, (e) => e.code === "PR_MERGE_METADATA_UNRESOLVED");
  assert.equal(r.reads(), 3);
  assert.equal(r.snapshots.at(-1).outcome, "PR_MERGE_METADATA_UNRESOLVED");
});
for (const [name, mutation, code] of [
  ["genuine HEAD drift", (p) => (p.head.sha = M), "HEAD_BASE_MERGE_DRIFT"],
  ["genuine base drift", (p) => (p.base.sha = H), "HEAD_BASE_MERGE_DRIFT"],
  ["wrong repository", (p) => p.head.repo.id++, "REPOSITORY_DRIFT"],
  ["unexpected concrete merge", (p) => (p.merge_commit_sha = H), "HEAD_BASE_MERGE_DRIFT"],
  ["missing merge field", (p) => delete p.merge_commit_sha, "HEAD_BASE_MERGE_DRIFT"],
])
  test(`metadata refresh never conceals ${name}`, async () => {
    const p = globalThis.structuredClone(identity().pr);
    mutation(p);
    const r = await reconciliation([p, identity().pr]);
    await assert.rejects(r.task, (e) => e.code === code);
    assert.equal(r.reads(), 1);
    assert.deepEqual(r.pauses, []);
    assert.equal(r.snapshots[0].outcome, code);
  });
test("a concrete stale SHA is never refreshed even when mergeability is unknown", async () => {
  const r = await reconciliation([{ ...incomplete(), merge_commit_sha: H }, identity().pr]);
  await assert.rejects(r.task, (e) => e.code === "HEAD_BASE_MERGE_DRIFT");
  assert.equal(r.reads(), 1);
});
test("HEAD changing during the bounded refresh invalidates reconciliation", async () => {
  const p = globalThis.structuredClone(identity().pr);
  p.head.sha = M;
  const r = await reconciliation([incomplete(), p, identity().pr]);
  await assert.rejects(r.task, (e) => e.code === "HEAD_BASE_MERGE_DRIFT");
  assert.equal(r.reads(), 2);
  assert.equal(r.snapshots.at(-1).comparisons.event_H_live_H, false);
});
for (const [name, mutate, code] of [
  ["wrong checkout", (v) => (v.checkout = { ...v.checkout, sha: H }), "CHECKOUT_COMMIT_DRIFT"],
  ["wrong parents", (v) => v.mergeCommit.parents.reverse(), "MERGE_PARENT_DRIFT"],
  ["unequal trees", (v) => (v.context = { ...v.context, TM: H }), "TREE_OR_BASE_DRIFT"],
  ["wrong native attempt", (v) => v.nativeRun.run_attempt++, "ATTEMPT_DRIFT"],
  ["wrong workflow", (v) => v.nativeRun.workflow_id++, "WORKFLOW_DRIFT"],
  [
    "missing native PR association",
    (v) => (v.nativeRun.pull_requests = []),
    "PR_ASSOCIATION_MISSING",
  ],
  ["wrong check App", (v) => v.suite.app.id++, "NATIVE_CHECK_SOURCE_DRIFT"],
])
  test(`incomplete PR metadata cannot defer ${name}`, async () => {
    const input = globalThis.structuredClone(reconciliationInput());
    mutate(input);
    const r = await reconciliation([incomplete(), identity().pr], input);
    await assert.rejects(r.task, (e) => e.code === code);
    assert.equal(r.reads(), 1);
    assert.deepEqual(r.pauses, []);
  });
test("identity diagnostics expose only selected public identity fields, never response extras or credentials", () => {
  const f = reconciliationInput(),
    p = globalThis.structuredClone(identity().pr);
  p.body = "CONFIDENTIAL_SENTINEL";
  p.user = { login: "CONFIDENTIAL_SENTINEL" };
  p.head.label = "CONFIDENTIAL_SENTINEL";
  f.nativeRun.actor = { token: "CONFIDENTIAL_SENTINEL" };
  const record = identityEvidence(
    f,
    p,
    1,
    {
      request_id: "Bearer CONFIDENTIAL_SENTINEL",
      authorization: "CONFIDENTIAL_SENTINEL",
      url: "https://example.invalid/?token=CONFIDENTIAL_SENTINEL",
    },
    "IDENTITY_CONFIRMED",
  );
  assert.equal(JSON.stringify(record).includes("CONFIDENTIAL_SENTINEL"), false);
  assert.equal(record.api.request_id, null);
  assert.deepEqual(record.git.merge_parents, [BASE, H]);
});

test("PR identity pins the supported merge-SHA API and rejects wrong or absent selected versions", () => {
  assert.deepEqual(PR_IDENTITY_API, {
    version: "2022-11-28",
    path: "pulls/100?identity_api=2022-11-28",
  });
  assert.doesNotThrow(() => validateIdentityApiVersion("2022-11-28"));
  for (const version of ["2026-03-10", null, undefined, "caller-controlled"])
    assert.throws(
      () => validateIdentityApiVersion(version),
      (e) => e.code === "PR_API_VERSION_DRIFT",
    );
});
test("diagnostics distinguish a removed merge field from a genuine null merge computation", () => {
  const p = identity().pr;
  delete p.merge_commit_sha;
  const missing = identityEvidence(reconciliationInput(), p, 1, {}, "HEAD_BASE_MERGE_DRIFT");
  assert.equal(missing.live_pr.M_present, false);
  assert.equal(missing.live_pr.M_type, "undefined");
  const pending = identityEvidence(
    reconciliationInput(),
    incomplete(),
    1,
    {},
    "PR_MERGE_METADATA_INCOMPLETE_REFRESH",
  );
  assert.equal(pending.live_pr.M_present, true);
  assert.equal(pending.live_pr.M_type, "object");
});

test("the actual PR reader sends the pinned API version, cache-qualified route and no credentials", async () => {
  const original = globalThis.fetch;
  let selected = "2022-11-28",
    calls = 0,
    correlation;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(
      url,
      "https://api.github.com/repos/mahmoudemad68/Your_Editor/pulls/100?identity_api=2022-11-28",
    );
    assert.equal(options.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(options.headers["Cache-Control"], "no-cache");
    assert.equal(options.headers.Authorization, undefined);
    return new globalThis.Response(JSON.stringify(identity().pr), {
      status: 200,
      headers: { "x-github-api-version-selected": selected, "x-github-request-id": "AB12:CD34" },
    });
  };
  try {
    const p = await readIdentityPr((v) => {
      correlation = v;
    });
    assert.equal(p.merge_commit_sha, M);
    assert.equal(correlation.api_version_selected, "2022-11-28");
    assert.equal(correlation.api_version_requested, "2022-11-28");
    selected = "2026-03-10";
    await assert.rejects(
      readIdentityPr(() => {}),
      (e) => e.code === "PR_API_VERSION_DRIFT",
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
  }
});

const MiB = 1024 * 1024;
function budgetFixture(C = 120 * MiB, R = (16 * MiB - 65536) / 2) {
  const sizes = Object.fromEntries(REPORT_FILES.map((n) => [n, 1]));
  sizes["candidate-manifest.json"] = R - (REPORT_FILES.length - 1);
  return {
    uncompressed_archive_bytes: 512 * MiB,
    C,
    report_file_bytes: sizes,
    compression: {
      algorithm: "xz",
      preset: 6,
      elapsed_seconds: 1,
      input_sha256: "a".repeat(64),
      output_sha256: "b".repeat(64),
      peak_rss_bytes: 1,
      user_cpu_seconds: 0.5,
      system_cpu_seconds: 0.1,
    },
  };
}
test("exact binary-MiB limits accept equality and account for both complete report copies", () => {
  const r = transferBudgetReport(budgetFixture());
  assert.equal(r.C, 125829120);
  assert.equal(r.R, 8355840);
  assert.equal(r.R_total, 16777216);
  assert.equal(r.combined_transfer_bytes, 268435456);
  assert.equal(r.within_budget, true);
  assert.deepEqual(r.predicates, { candidate: true, replicated_provenance: true, combined: true });
  assert.equal(r.retention_days, 1);
});
test("candidate one byte above its cap fails independently of the other predicates", () => {
  const r = transferBudgetReport(budgetFixture(120 * MiB + 1, 100));
  assert.deepEqual(r.predicates, { candidate: false, replicated_provenance: true, combined: true });
});
test("one extra provenance byte per copy exceeds the replicated cap by exactly two bytes", () => {
  const r = transferBudgetReport(budgetFixture(1, (16 * MiB - 65536) / 2 + 1));
  assert.equal(r.R_total, 16 * MiB + 2);
  assert.deepEqual(r.predicates, { candidate: true, replicated_provenance: false, combined: true });
});
test("combined limit is enforced; integer two-copy accounting cannot produce a one-byte excess or an isolated total failure", () => {
  const r = transferBudgetReport(budgetFixture(120 * MiB + 1));
  assert.equal(r.combined_transfer_bytes, 256 * MiB + 2);
  assert.equal(r.predicates.combined, false);
  for (const C of [1, 120 * MiB - 1, 120 * MiB])
    for (const R of [REPORT_FILES.length, 8355839, 8355840]) {
      const b = transferBudgetReport(budgetFixture(C, R));
      assert.equal(b.predicates.combined, true);
      assert.equal(b.combined_transfer_bytes % 2, 0);
    }
});
test("all report files and manifest contribute once per bundle and twice to stored provenance", () => {
  const m = budgetFixture(1, 200),
    r = transferBudgetReport(m);
  assert.equal(
    r.R,
    Object.values(m.report_file_bytes).reduce((a, b) => a + b, 0),
  );
  assert.equal(r.R_total, 400 + 65536);
  m.report_file_bytes["go-version-m.txt"]++;
  const n = transferBudgetReport(m);
  assert.equal(n.R, r.R + 1);
  assert.equal(n.R_total, r.R_total + 2);
});
for (const [name, mutate] of [
  ["missing C", (m) => delete m.C],
  ["fractional bytes", (m) => (m.C = 1.5)],
  ["negative bytes", (m) => (m.C = -1)],
  ["infinite bytes", (m) => (m.C = Infinity)],
  ["missing archive size", (m) => delete m.uncompressed_archive_bytes],
  ["missing report", (m) => delete m.report_file_bytes["verification.json"]],
  ["unexpected duplicate alias", (m) => (m.report_file_bytes["second-copy.json"] = 1)],
  ["zero report", (m) => (m.report_file_bytes["verification.json"] = 0)],
  ["unsafe total arithmetic", (m) => (m.C = Number.MAX_SAFE_INTEGER)],
  ["missing compression", (m) => delete m.compression],
  ["missing elapsed", (m) => delete m.compression.elapsed_seconds],
  ["invalid digest", (m) => (m.compression.input_sha256 = "secret")],
  ["unexpected algorithm", (m) => (m.compression.algorithm = "caller-controlled")],
  ["unapproved preset", (m) => (m.compression.preset = 0)],
  ["invalid RSS", (m) => (m.compression.peak_rss_bytes = -1)],
  ["fractional RSS bytes", (m) => (m.compression.peak_rss_bytes = 1.5)],
])
  test(`budget measurements fail closed: ${name}`, () => {
    const m = budgetFixture();
    mutate(m);
    assert.throws(
      () => transferBudgetReport(m),
      (e) => e.code === "TRANSFER_MEASUREMENT_INVALID",
    );
  });
test("pre-gate report is emitted before budget rejection and cannot be mutated to make the gate pass", async () => {
  const order = [];
  let consumerActivated = false;
  await assert.rejects(
    async () => {
      await reportAndEnforceTransfer(
        budgetFixture(120 * MiB + 1),
        async (r) => {
          order.push("report");
          r.within_budget = true;
        },
        async (r) => {
          order.push("probe");
          r.within_budget = true;
          return true;
        },
      );
      consumerActivated = true;
    },
    (e) => e.code === "TRANSFER_BUDGET_EXCEEDED",
  );
  assert.deepEqual(order, ["report", "probe"]);
  assert.equal(consumerActivated, false);
});
test("diagnostic failures preserve the original rejection and never expose exception contents", async () => {
  const records = [];
  await assert.rejects(
    reportAndEnforceTransfer(
      budgetFixture(120 * MiB + 1),
      async (r) => records.push(r),
      async () => {
        throw Error("PRIVATE_SENTINEL");
      },
    ),
    (e) => e.code === "TRANSFER_BUDGET_EXCEEDED",
  );
  assert.equal(JSON.stringify(records).includes("PRIVATE_SENTINEL"), false);
  await assert.rejects(
    reportAndEnforceTransfer(budgetFixture(), async () => {
      throw Error("PRIVATE_SENTINEL");
    }),
    (e) => e.code === "BUDGET_REPORT_EMISSION_FAILED",
  );
});
test("missing measurement rejects before emitting any false passing report", async () => {
  let emitted = false;
  await assert.rejects(
    reportAndEnforceTransfer(undefined, async () => {
      emitted = true;
    }),
    (e) => e.code === "TRANSFER_MEASUREMENT_INVALID",
  );
  assert.equal(emitted, false);
});
test("an over-budget process exits nonzero before any consumer or artifact-success continuation", () => {
  const script = `import {reportAndEnforceTransfer} from './tools/test/load-qualified-storage.mjs'; await reportAndEnforceTransfer(${JSON.stringify(budgetFixture(120 * MiB + 1))},async r=>console.log(JSON.stringify(r)),async()=>true); console.log('CONSUMER_ACTIVATED');`;
  let output = "";
  assert.throws(
    () =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    (e) => {
      output = e.stdout;
      return e.status !== 0;
    },
  );
  assert.ok(output.includes("TRANSFER_BUDGET_MEASUREMENT"));
  assert.equal(output.includes("CONSUMER_ACTIVATED"), false);
});
test("real bounded XZ compression metadata and roundtrip agree with actual file bytes", async () =>
  temporary(async (dir) => {
    const src = path.join(dir, "source.bin"),
      out = path.join(dir, "candidate.xz"),
      decoded = path.join(dir, "roundtrip.bin");
    const data = Buffer.from("public synthetic full-image byte preservation control\n".repeat(100));
    await writeFile(src, data);
    const c = compressArchive(src, out, 6, python);
    assert.equal(c.input_sha256, sha256(data));
    assert.equal(c.uncompressed_bytes, data.length);
    assert.equal(c.output_sha256, sha256(await readFile(out)));
    assert.ok(c.elapsed_seconds > 0);
    const d = await decompress(out, decoded, python);
    assert.equal(d.uncompressed_bytes, data.length);
    assert.deepEqual(await readFile(decoded), data);
  }));
test("forensics cannot alter default compression or upload after produce fails", async () => {
  const code = await readFile(path.join(root, "tools/test/load-qualified-storage.mjs"), "utf8");
  assert.ok(
    code
      .replace(/\s/g, "")
      .replaceAll(",)", ")")
      .includes(
        'compressArchive(path.join(work,"candidate.tar"),path.join(folder,"image.tar.xz"),6)',
      ),
  );
  const flow = await readFile(path.join(root, ".github/workflows/supply-chain.yml"), "utf8");
  assert.ok(
    flow.indexOf("Fixed module reproducibility and zero HIGH gate") <
      flow.indexOf("Upload qualified candidate"),
  );
  const gate = flow.slice(
    flow.indexOf("Fixed module reproducibility and zero HIGH gate"),
    flow.indexOf("Upload qualified candidate"),
  );
  assert.equal(gate.includes("continue-on-error"), false);
});

function filteredFixture() {
  const m = budgetFixture(120 * MiB, 100);
  const identity = {
    image_id: "sha256:" + "c".repeat(64),
    config_sha256: "c".repeat(64),
    elf_sha256: "d".repeat(64),
    layer_diff_ids: Array.from({ length: 6 }, (_, i) => "sha256:" + String(i).repeat(64)),
    old_elf_absent: true,
    runtime_preserved: true,
    native_brotli: "1.2.1-r0",
    rust_sha256: { "usr/bin/weed-volume": "e".repeat(64), "usr/bin/weed-worker": "f".repeat(64) },
  };
  const expected = {
    archive_sha256: "a".repeat(64),
    archive_bytes: 512 * MiB,
    report_file_bytes: m.report_file_bytes,
    identity,
  };
  const encoder = {
    ...m.compression,
    profile: FILTER_PROFILE,
    filter_chain: ["X86", "LZMA2_PRESET_9"],
    preset: 9,
    check: "CRC64",
    runtime: { platform: "linux", python: "3.12.3", implementation: "CPython", liblzma: "5.8.1" },
    process_wall_seconds: 2,
    uncompressed_bytes: expected.archive_bytes,
    compressed_bytes: m.C,
    limits: { address_space_bytes: 1073741824, cpu_seconds: 480 },
  };
  const result = {
    encoder,
    budget: transferBudgetReport({ ...m, compression: encoder }),
    decoding: {
      elapsed_seconds: 1,
      peak_rss_bytes: 128 * MiB,
      uncompressed_bytes: expected.archive_bytes,
      limits: { address_space_bytes: 268435456 },
    },
    archive_sha256: expected.archive_sha256,
    identity: globalThis.structuredClone(identity),
    artifact_uploaded: false,
  };
  return { expected, result };
}
test("filtered capacity/resource/integrity success permits exactly two independent measurements and no qualification", async () => {
  const f = filteredFixture(),
    records = [];
  assert.doesNotThrow(() => validateFilterAttempt(f.result, f.expected));
  let attempts = 0;
  const verdict = await runBoundedFilterExperiment(
    f.expected,
    async () => {
      attempts++;
      return globalThis.structuredClone(f.result);
    },
    async (r) => records.push(r),
  );
  assert.equal(attempts, 2);
  assert.equal(verdict, "FULL_IMAGE_FILTER_FEASIBILITY=MET_EXPERIMENT_ONLY");
  assert.ok(records.every((r) => r.qualified === false));
});
for (const [name, mutate] of [
  [
    "candidate over cap",
    (f) => {
      f.result.encoder.compressed_bytes++;
      f.result.budget = transferBudgetReport({
        uncompressed_archive_bytes: f.expected.archive_bytes,
        C: f.result.encoder.compressed_bytes,
        report_file_bytes: f.expected.report_file_bytes,
        compression: f.result.encoder,
      });
    },
  ],
  [
    "provenance over cap",
    (f) => {
      const m = budgetFixture(1, 8355841);
      f.expected.report_file_bytes = m.report_file_bytes;
      f.result.encoder.compressed_bytes = 1;
      f.result.budget = transferBudgetReport({ ...m, compression: f.result.encoder });
    },
  ],
  [
    "combined over cap",
    (f) => {
      const m = budgetFixture(120 * MiB + 1);
      f.expected.report_file_bytes = m.report_file_bytes;
      f.result.encoder.compressed_bytes = m.C;
      f.result.budget = transferBudgetReport({ ...m, compression: f.result.encoder });
    },
  ],
  ["nonidentical decoded archive", (f) => (f.result.archive_sha256 = "0".repeat(64))],
  ["encoder wall exceeded", (f) => (f.result.encoder.process_wall_seconds = 540.001)],
  ["encoder CPU exceeded", (f) => (f.result.encoder.user_cpu_seconds = 480.1)],
  ["encoder RSS exceeded", (f) => (f.result.encoder.peak_rss_bytes = 1073741825)],
  ["encoder limits unavailable", (f) => delete f.result.encoder.limits],
  ["decoder memory exceeded", (f) => (f.result.decoding.peak_rss_bytes = 256 * MiB + 1)],
  ["decoder limit unavailable", (f) => delete f.result.decoding.limits],
  ["decoder expansion exceeded", (f) => (f.result.decoding.uncompressed_bytes = 4 * 1024 ** 3 + 1)],
  ["decoder deadline exceeded", (f) => (f.result.decoding.elapsed_seconds = 601)],
  ["measurement unavailable", (f) => (f.result = null)],
  ["unknown liblzma runtime", (f) => (f.result.encoder.runtime.liblzma = "UNAVAILABLE")],
  ["unexpected filter", (f) => f.result.encoder.filter_chain.reverse()],
  ["unexpected image", (f) => (f.result.identity.image_id = "sha256:" + "0".repeat(64))],
  ["unexpected config", (f) => (f.result.identity.config_sha256 = "0".repeat(64))],
  ["unexpected layer", (f) => (f.result.identity.layer_diff_ids[0] = "sha256:" + "f".repeat(64))],
  ["unexpected ELF", (f) => (f.result.identity.elf_sha256 = "0".repeat(64))],
  ["old vulnerable ELF retained", (f) => (f.result.identity.old_elf_absent = false)],
  ["native runtime changed", (f) => (f.result.identity.native_brotli = "1.2.0-r1")],
  ["experimental artifact promoted", (f) => (f.result.artifact_uploaded = true)],
])
  test(`filtered first-attempt failure stops all further compression: ${name}`, async () => {
    const f = filteredFixture();
    mutate(f);
    let attempts = 0;
    const records = [];
    const verdict = await runBoundedFilterExperiment(
      f.expected,
      async () => {
        attempts++;
        return f.result;
      },
      async (r) => records.push(r),
    );
    assert.equal(verdict, "FULL_IMAGE_FILTER_FEASIBILITY=NOT_MET");
    assert.equal(attempts, 1);
    assert.equal(records.at(-1).verdict, verdict);
  });
test("unequal independent compressed outputs fail reproducibility and cannot request another profile", async () => {
  const f = filteredFixture(),
    records = [];
  let n = 0;
  const verdict = await runBoundedFilterExperiment(
    f.expected,
    async () => {
      const r = globalThis.structuredClone(f.result);
      if (++n === 2) r.encoder.output_sha256 = "e".repeat(64);
      return r;
    },
    async (r) => records.push(r),
  );
  assert.equal(n, 2);
  assert.equal(verdict, "FULL_IMAGE_FILTER_FEASIBILITY=NOT_MET");
  assert.equal(records.at(-1).failure, "FILTER_REPRODUCIBILITY_FAILED");
});
test("compression exception cannot trigger a second attempt or leak its private message", async () => {
  const f = filteredFixture(),
    records = [];
  let n = 0;
  const verdict = await runBoundedFilterExperiment(
    f.expected,
    async () => {
      n++;
      throw Error("PRIVATE_SENTINEL");
    },
    async (r) => records.push(r),
  );
  assert.equal(n, 1);
  assert.equal(verdict, "FULL_IMAGE_FILTER_FEASIBILITY=NOT_MET");
  assert.equal(JSON.stringify(records).includes("PRIVATE_SENTINEL"), false);
});
test("filtered feasibility success never promotes the experiment or rescues the original XZ6 failure", async () => {
  const f = filteredFixture();
  let consumer = false;
  await assert.rejects(
    async () => {
      await reportAndEnforceTransfer(
        budgetFixture(120 * MiB + 1),
        async () => {},
        () =>
          runBoundedFilterExperiment(
            f.expected,
            async () => f.result,
            async () => {},
          ),
      );
      consumer = true;
    },
    (e) => e.code === "TRANSFER_BUDGET_EXCEEDED",
  );
  assert.equal(consumer, false);
});
test("real BCJ/LZMA2 stream roundtrips, repeats compressed bytes, and rejects corruption", async () =>
  temporary(async (dir) => {
    const src = path.join(dir, "full-archive.bin");
    const bytes = Buffer.concat([
      Buffer.from([0xe8, 0x40, 0, 0, 0, 0xe9, 0x80, 0, 0, 0]),
      Buffer.from("public synthetic binary fixture".repeat(200)),
    ]);
    await writeFile(src, bytes);
    const hashes = [];
    for (const n of [1, 2]) {
      const packed = path.join(dir, `bcj-${n}.xz`),
        decoded = path.join(dir, `decoded-${n}.bin`);
      const m = compressArchive(src, packed, 9, python, FILTER_PROFILE);
      assert.deepEqual(m.filter_chain, ["X86", "LZMA2_PRESET_9"]);
      assert.equal(m.input_sha256, sha256(bytes));
      hashes.push(m.output_sha256);
      await decompress(packed, decoded, python);
      assert.deepEqual(await readFile(decoded), bytes);
    }
    assert.equal(hashes[0], hashes[1]);
    const corrupt = await readFile(path.join(dir, "bcj-1.xz"));
    corrupt[Math.floor(corrupt.length / 2)] ^= 255;
    const bad = path.join(dir, "corrupt.xz");
    await writeFile(bad, corrupt);
    await assert.rejects(decompress(bad, path.join(dir, "rejected.bin"), python));
    assert.throws(
      () => compressArchive(src, path.join(dir, "bad.xz"), 6, python, FILTER_PROFILE),
      (e) => e.code === "COMPRESSION_SETTING_REJECTED",
    );
  }));

function ociFixture(dir, scenario = "raw") {
  const result = execFileSync(
    python,
    [
      "-c",
      String.raw`
import tarfile,io,json,hashlib,sys,gzip
from pathlib import Path
p=Path(sys.argv[1]);scenario=sys.argv[2];sha=lambda b:hashlib.sha256(b).hexdigest()
new=b'\x7fELFpublic synthetic new weed';old=b'\x7fELFpublic synthetic old weed';rust=[b'\x7fELFpublic volume',b'\x7fELFpublic worker']
def regular(n,b):
 t=tarfile.TarInfo(n);t.mode=0o755 if n.startswith('usr/bin/') else 0o644;t.size=len(b);return t,b
def layer(entries,fmt=tarfile.USTAR_FORMAT):
 b=io.BytesIO()
 with tarfile.open(fileobj=b,mode='w',format=fmt) as t:
  for info,data in entries:t.addfile(info,io.BytesIO(data))
 return b.getvalue()
entries=[regular('usr/bin/weed',new)]
if scenario=='old-elf':entries.append(regular('usr/lib/old-weed',old))
if scenario=='hidden-elf':entries.append(regular('usr/share/editagent-seaweedfs/hidden',old))
if scenario=='compiler':entries.append(regular('usr/local/go/bin/go',b'compiler'))
if scenario=='traversal':entries.append(regular('../escape',b'x'))
if scenario=='whiteout':entries.append(regular('usr/bin/.wh.weed',b''))
if scenario=='duplicate':entries.append(regular('usr/bin/weed',new))
if scenario in ('hardlink','symlink','parent-link'):
 t=tarfile.TarInfo('usr/link');t.type=tarfile.LNKTYPE if scenario=='hardlink' else tarfile.SYMTYPE;t.linkname='missing' if scenario=='hardlink' else ('link' if scenario=='symlink' else '/tmp')
 entries.append((t,b''))
 if scenario=='parent-link':entries.append(regular('usr/link/file',b'x'))
fmt=tarfile.USTAR_FORMAT
if scenario in ('pax-bad','pax-good'):
 fmt=tarfile.PAX_FORMAT;entries[0][0].pax_headers={'UNAPPROVED.key':'x'} if scenario=='pax-bad' else {'mtime':'123.25'}
empty=layer([]);layers=[layer(entries,fmt),layer([regular('usr/bin/weed-volume',rust[0])]),layer([regular('usr/bin/weed-worker',rust[1])]),empty,layer([regular('etc/public',b'public synthetic metadata')]),empty]
ds=['sha256:'+sha(x) for x in layers]
if scenario=='encoded-confusion':ds[0]='sha256:'+sha(gzip.compress(layers[0],mtime=0))
cfg=json.dumps({'architecture':'arm64' if scenario=='platform' else 'amd64','os':'linux','rootfs':{'type':'layers','diff_ids':ds},'config':{'Env':['PUBLIC_SYNTHETIC=1']},'history':[]},sort_keys=True).encode();q=sha(cfg)
files={q+'.json':cfg};names=[]
for i,b in enumerate(layers):n='layers/'+str(i)+'/layer.tar';names.append(n);files[n]=b
if scenario in ('gzip','source-index-drift'):
 files={'blobs/sha256/'+q:cfg};names=[];descs=[]
 for b in layers:
  z=gzip.compress(b,mtime=0);d=sha(z);n='blobs/sha256/'+d;files[n]=z;names.append(n);descs.append({'mediaType':'application/vnd.oci.image.layer.v1.tar+gzip','digest':'sha256:'+d,'size':len(z)})
 manifest=json.dumps({'schemaVersion':2,'mediaType':'application/vnd.oci.image.manifest.v1+json','config':{'mediaType':'application/vnd.oci.image.config.v1+json','digest':'sha256:'+('0'*64 if scenario=='source-index-drift' else q),'size':len(cfg)},'layers':descs}).encode()
 files['blobs/sha256/'+sha(manifest)]=manifest;files['oci-layout']=b'{"imageLayoutVersion":"1.0.0"}';files['index.json']=json.dumps({'schemaVersion':2,'manifests':[{'mediaType':'application/vnd.oci.image.manifest.v1+json','digest':'sha256:'+sha(manifest),'size':len(manifest)}]}).encode();config_name='blobs/sha256/'+q
else:config_name=q+'.json'
files['manifest.json']=json.dumps([{'Config':config_name,'RepoTags':[],'Layers':names}]).encode()
src=p/'source.tar'
with tarfile.open(src,'w',format=tarfile.USTAR_FORMAT) as t:
 for n,b in files.items():t.addfile(*((lambda a:(a,io.BytesIO(b)))(regular(n,b)[0])))
print(json.dumps({'source':str(src),'source_sha256':sha(src.read_bytes()),'image_id':'sha256:'+q,'elf_sha256':sha(new),'rust_sha256':{'usr/bin/weed-volume':sha(rust[0]),'usr/bin/weed-worker':sha(rust[1])},'old_elf_sha256':sha(old)}))
`,
      dir,
      scenario,
    ],
    { encoding: "utf8" },
  );
  return JSON.parse(result);
}
function mutateOCI(source, target, variant) {
  execFileSync(python, [
    "-c",
    String.raw`
import tarfile,json,hashlib,sys
src,dst,variant=sys.argv[1:];sha=lambda b:hashlib.sha256(b).hexdigest();enc=lambda v:(json.dumps(v,sort_keys=True,separators=(',',':'))+'\n').encode()
with tarfile.open(src,'r:') as t:
 files={m.name+('/' if m.isdir() and not m.name.endswith('/') else ''):(m,b'' if m.isdir() else t.extractfile(m).read()) for m in t}
idx=json.loads(files['index.json'][1]);mn='blobs/sha256/'+idx['manifests'][0]['digest'][7:];m=json.loads(files[mn][1]);cn='blobs/sha256/'+m['config']['digest'][7:];ln='blobs/sha256/'+m['layers'][0]['digest'][7:]
if variant=='missing':files.pop(ln)
elif variant=='extra':files['blobs/sha256/'+'e'*64]=(tarfile.TarInfo('x'),b'EXTRA')
elif variant=='blob':files[ln]=(files[ln][0],files[ln][1][:-1]+b'X')
elif variant=='config':files[cn]=(files[cn][0],files[cn][1]+b' ')
elif variant=='platform':idx['manifests'][0]['platform']['architecture']='arm64'
elif variant=='index-many':idx['manifests']*=2
elif variant in ('media','order','urls'):
 if variant=='media':m['layers'][0]['mediaType']+=' +gzip'
 if variant=='order':m['layers'][0],m['layers'][1]=m['layers'][1],m['layers'][0]
 if variant=='urls':m['layers'][0]['urls']=['https://untrusted.invalid/blob']
 b=enc(m);files.pop(mn);mn='blobs/sha256/'+sha(b);files[mn]=(tarfile.TarInfo('x'),b);idx['manifests'][0]['digest']='sha256:'+sha(b);idx['manifests'][0]['size']=len(b)
elif variant=='traversal':files['../escape']=(tarfile.TarInfo('x'),b'x')
elif variant=='outer-link':
 t=tarfile.TarInfo('x');t.type=tarfile.SYMTYPE;t.linkname='../escape';files['blobs/sha256/'+'f'*64]=(t,b'')
files['index.json']=(files['index.json'][0],enc(idx))
if variant=='invalid-json':files['index.json']=(files['index.json'][0],b'\xff')
if variant=='json-duplicate':files['index.json']=(files['index.json'][0],b'{"schemaVersion":2,"schemaVersion":2}')
with open(dst,'xb') as out:
 for n,(old,b) in files.items():
  t=tarfile.TarInfo(n);t.type=old.type;t.linkname=old.linkname;t.size=len(b);t.mode=0o755 if t.isdir() else 0o644;t.uid=t.gid=t.mtime=0;t.uname=t.gname=''
  h=t.tobuf(format=tarfile.USTAR_FORMAT);out.write(h);out.write(b);out.write(b'\0'*((-len(b))%512))
  if variant=='duplicate' and n=='index.json':out.write(h);out.write(b);out.write(b'\0'*((-len(b))%512))
 out.write(b'\0'*1024)
 if variant=='trailing':out.write(b'EVIL')
`,
    source,
    target,
    variant,
  ]);
}
for (const scenario of ["raw", "gzip", "pax-good"])
  test(`OCI software fixture preserves config, six layer positions, metadata and adapter: ${scenario}`, async () =>
    temporary(async (dir) => {
      const f = ociFixture(dir, scenario),
        raw = path.join(dir, "oci.tar");
      const p = runOCITool("pack", f.source, raw, f, python);
      assert.equal(p.layers.length, 6);
      assert.equal(p.unique_raw_blobs, 5);
      assert.equal(p.layers[3].diff_id, p.layers[5].diff_id);
      const adapter = path.join(dir, "adapter.tar"),
        expected = { ...f, ...p };
      const v = runOCITool("validate", raw, adapter, expected, python);
      assert.equal(v.config_sha256, f.image_id.slice(7));
      assert.equal(v.image_id, f.image_id);
      const r = runOCITool(
        "resave",
        adapter,
        path.join(dir, "unused"),
        { ...expected, source_sha256: undefined },
        python,
      );
      assert.equal(r.metadata_sha256, p.metadata_sha256);
      assert.deepEqual(
        r.layers.map((l) => l.diff_id),
        p.layers.map((l) => l.diff_id),
      );
      const second = path.join(dir, "second.tar");
      runOCITool("pack", f.source, second, f, python);
      assert.equal(sha256(await readFile(raw)), sha256(await readFile(second)));
    }));
for (const scenario of [
  "traversal",
  "whiteout",
  "duplicate",
  "hardlink",
  "symlink",
  "parent-link",
  "pax-bad",
  "old-elf",
  "hidden-elf",
  "compiler",
  "platform",
  "encoded-confusion",
  "source-index-drift",
])
  test(`OCI refuses unsupported or unsafe original layer without rewriting: ${scenario}`, async () =>
    temporary(async (dir) => {
      const f = ociFixture(dir, scenario);
      assert.throws(
        () => runOCITool("pack", f.source, path.join(dir, "oci.tar"), f, python),
        (e) => /^OCI_/.test(e.code),
      );
    }));
for (const variant of [
  "missing",
  "duplicate",
  "extra",
  "blob",
  "config",
  "platform",
  "index-many",
  "media",
  "order",
  "urls",
  "traversal",
  "outer-link",
  "invalid-json",
  "json-duplicate",
  "trailing",
])
  test(`OCI decoded closure negative control: ${variant}`, async () =>
    temporary(async (dir) => {
      const f = ociFixture(dir),
        raw = path.join(dir, "raw.tar"),
        p = runOCITool("pack", f.source, raw, f, python),
        bad = path.join(dir, "bad.tar");
      mutateOCI(raw, bad, variant);
      assert.throws(
        () => runOCITool("validate", bad, path.join(dir, "adapter.tar"), { ...f, ...p }, python),
        (e) => /^OCI_/.test(e.code),
      );
    }));

function ociResultFixture() {
  const f = filteredFixture(),
    identity = f.expected.identity;
  const measurement = {
    wall_seconds: 1,
    peak_rss_bytes: 64 * MiB,
    user_cpu_seconds: 1,
    system_cpu_seconds: 0,
    limits: { address_space_bytes: 268435456, cpu_seconds: 120 },
  };
  const command = { wall_seconds: 1, peak_waited_child_rss_bytes: 64 * MiB, deadline_seconds: 240 };
  const reports = budgetFixture(1, 100).report_file_bytes;
  const encoder = {
    ...f.result.encoder,
    profile: OCI_PROFILE,
    preset: 6,
    filter_chain: ["LZMA2_PRESET_6"],
    compressed_bytes: 1024,
    input_sha256: "b".repeat(64),
  };
  const pack = {
    source_sha256: f.expected.archive_sha256,
    image_id: identity.image_id,
    config_bytes: 100,
    layers: identity.layer_diff_ids.map((diff_id) => ({ diff_id })),
    layout: { bytes: 4096, sha256: encoder.input_sha256 },
    metadata_sha256: "a".repeat(64),
    measurement,
  };
  const result = {
    pack,
    encoder,
    decoding: { ...f.result.decoding, uncompressed_bytes: 4096 },
    decoded_sha256: pack.layout.sha256,
    validation: {
      image_id: identity.image_id,
      config_sha256: identity.config_sha256,
      elf_sha256: identity.elf_sha256,
      layout_sha256: pack.layout.sha256,
      layout_bytes: pack.layout.bytes,
      metadata_sha256: pack.metadata_sha256,
      ordered_diff_ids: identity.layer_diff_ids,
      measurement,
    },
    imported: {
      Id: identity.image_id,
      Os: "linux",
      Architecture: "amd64",
      RootFS: { Type: "layers", Layers: identity.layer_diff_ids },
    },
    resave: {
      image_id: identity.image_id,
      config_bytes: 100,
      layers: pack.layers,
      metadata_sha256: pack.metadata_sha256,
      measurement,
    },
    adapter_verification: command,
    loaded_verification: command,
    import_measurement: {
      ...command,
      daemon: { observed_processes: 1, peak_sampled_rss_bytes: MiB, lifetime_hwm_upper_bytes: MiB },
    },
    export_measurement: command,
    adapter_identity: identity,
    loaded_identity: identity,
    report_file_bytes: reports,
    artifact_uploaded: false,
    production_format_unchanged: true,
  };
  result.budget = transferBudgetReport({
    uncompressed_archive_bytes: 4096,
    C: 1024,
    report_file_bytes: reports,
    compression: encoder,
  });
  result.zip_bound = ociZipBound(1024, reports);
  return { expected: { source_sha256: f.expected.archive_sha256, identity }, result };
}
test("OCI first full pass permits exactly one repeat, remains diagnostic-only", async () => {
  const f = ociResultFixture(),
    records = [];
  let attempts = 0;
  assert.doesNotThrow(() => validateOCIAttempt(f.result, f.expected));
  assert.equal(
    await runBoundedOCIExperiment(
      f.expected,
      async () => {
        attempts++;
        return globalThis.structuredClone(f.result);
      },
      async (r) => records.push(r),
    ),
    "OCI_REPRESENTATION_FEASIBILITY=MET_DIAGNOSTIC_ONLY",
  );
  assert.equal(attempts, 2);
  assert.ok(records.every((r) => r.qualified === false));
});
for (const [name, mutate] of [
  ["promotion", (f) => (f.result.artifact_uploaded = true)],
  ["default format", (f) => (f.result.production_format_unchanged = false)],
  ["missing measurements", (f) => delete f.result.decoding],
  ["CPU", (f) => (f.result.encoder.user_cpu_seconds = 481)],
  ["encoder memory", (f) => (f.result.encoder.peak_rss_bytes = 1073741825)],
  ["wall deadline", (f) => (f.result.encoder.process_wall_seconds = 541)],
  ["decoder memory", (f) => (f.result.decoding.peak_rss_bytes = 268435457)],
  [
    "parser memory",
    (f) => {
      f.result.pack.measurement = { ...f.result.pack.measurement, peak_rss_bytes: 268435457 };
    },
  ],
  ["daemon measurement", (f) => delete f.result.import_measurement.daemon],
  ["config", (f) => (f.result.validation.config_sha256 = "0".repeat(64))],
  ["import", (f) => (f.result.imported.Id = "sha256:" + "0".repeat(64))],
  [
    "raw diff",
    (f) => {
      f.result.resave.layers = globalThis.structuredClone(f.result.resave.layers);
      f.result.resave.layers[0].diff_id = "sha256:" + "f".repeat(64);
    },
  ],
  [
    "ELF",
    (f) => {
      f.result.loaded_identity = { ...f.result.loaded_identity, elf_sha256: "0".repeat(64) };
    },
  ],
  [
    "capacity",
    (f) => {
      f.result.encoder.compressed_bytes = 125829121;
      f.result.budget = transferBudgetReport({
        uncompressed_archive_bytes: 4096,
        C: 125829121,
        report_file_bytes: f.result.report_file_bytes,
        compression: f.result.encoder,
      });
    },
  ],
  [
    "ZIP reserve",
    (f) => {
      f.result.encoder.compressed_bytes = 120 * MiB;
      f.result.budget = transferBudgetReport({
        uncompressed_archive_bytes: 4096,
        C: 120 * MiB,
        report_file_bytes: f.result.report_file_bytes,
        compression: f.result.encoder,
      });
      f.result.zip_bound = ociZipBound(120 * MiB, f.result.report_file_bytes);
    },
  ],
  ["invalid ZIP metadata", (f) => (f.result.zip_bound.within_reserve = false)],
])
  test(`OCI first failure stops all subsequent encoding: ${name}`, async () => {
    const f = ociResultFixture();
    mutate(f);
    let n = 0;
    assert.equal(
      await runBoundedOCIExperiment(
        f.expected,
        async () => {
          n++;
          return f.result;
        },
        async () => {},
      ),
      "OCI_REPRESENTATION_FEASIBILITY=NOT_MET",
    );
    assert.equal(n, 1);
  });
test("OCI unequal independent encodings fail; exception cannot leak or retry", async () => {
  const f = ociResultFixture();
  let n = 0;
  const records = [];
  assert.equal(
    await runBoundedOCIExperiment(
      f.expected,
      async () => {
        const r = globalThis.structuredClone(f.result);
        if (++n === 2) r.encoder.output_sha256 = "f".repeat(64);
        return r;
      },
      async (r) => records.push(r),
    ),
    "OCI_REPRESENTATION_FEASIBILITY=NOT_MET",
  );
  assert.equal(n, 2);
  n = 0;
  assert.equal(
    await runBoundedOCIExperiment(
      f.expected,
      async () => {
        n++;
        throw Error("PRIVATE_SENTINEL");
      },
      async (r) => records.push(r),
    ),
    "OCI_REPRESENTATION_FEASIBILITY=NOT_MET",
  );
  assert.equal(n, 1);
  assert.equal(JSON.stringify(records).includes("PRIVATE_SENTINEL"), false);
});
test("synthetic complete OCI uses only fixed XZ6 and decodes byte-identically", async () =>
  temporary(async (dir) => {
    const f = ociFixture(dir),
      raw = path.join(dir, "raw.tar"),
      packed = path.join(dir, "oci.xz"),
      decoded = path.join(dir, "decoded.tar");
    const p = runOCITool("pack", f.source, raw, f, python);
    const c = compressArchive(raw, packed, 6, python, OCI_PROFILE);
    assert.equal(c.profile, OCI_PROFILE);
    assert.deepEqual(c.filter_chain, ["LZMA2_PRESET_6"]);
    await decompress(packed, decoded, python, 4 * 1024 ** 3, true);
    assert.equal(sha256(await readFile(decoded)), p.layout.sha256);
    runOCITool("validate", decoded, path.join(dir, "adapter.tar"), { ...f, ...p }, python);
    assert.throws(
      () => compressArchive(raw, path.join(dir, "wrong.xz"), 9, python, OCI_PROFILE),
      (e) => e.code === "COMPRESSION_SETTING_REJECTED",
    );
  }));
test("even successful OCI diagnostic cannot rescue production budget or activate consumers", async () => {
  const f = ociResultFixture();
  let continued = false;
  await assert.rejects(
    async () => {
      await reportAndEnforceTransfer(
        budgetFixture(125829121),
        async () => {},
        () =>
          runBoundedOCIExperiment(
            f.expected,
            async () => f.result,
            async () => {},
          ),
      );
      continued = true;
    },
    (e) => e.code === "TRANSFER_BUDGET_EXCEEDED",
  );
  assert.equal(continued, false);
});
