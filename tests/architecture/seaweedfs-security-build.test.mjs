/** Admission software controls; synthetic inputs are not runtime qualification. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  parseCommitMetadata,
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
