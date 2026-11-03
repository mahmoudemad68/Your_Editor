/** Actual parser, shell and workflow regression controls for independent QA findings. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import {
  pages,
  strictJSON,
  sha256,
  validateReceiptPaths,
  verifyApprovedELF,
} from "../../tools/test/load-qualified-storage.mjs";
const root = path.resolve(import.meta.dirname, "../.."),
  python = process.env.TEST_PYTHON ?? "python3";
const read = async (p) => (await readFile(path.join(root, p), "utf8")).replace(/\r\n/g, "\n");
const job = (text, name) => text.split(`  ${name}:\n`)[1]?.split(/\n {2}[a-z][a-z-]*:\n/)[0];
test("B-1 ordinary scan jobs are not dependent on PC100 source approval", async () => {
  const s = await read(".github/workflows/supply-chain.yml"),
    ci = await read(".github/workflows/ci.yml");
  assert.match(
    job(s, "source-policy"),
    /if: github.event_name == 'pull_request' && github.event.pull_request.number == 100/,
  );
  assert.doesNotMatch(job(s, "dependencies"), /needs: source-policy/);
  assert.match(
    job(s, "images"),
    /github.event_name != 'pull_request' \|\| github.event.pull_request.number != 100 \|\| needs.source-policy.result == 'success'/,
  );
  assert.match(job(s, "supply-chain-security"), /test "\$IMAGES_RESULT" = success/);
  assert.match(
    job(s, "supply-chain-security"),
    /if \[ "\$CANDIDATE_EVENT" = true \]; then test "\$POLICY_RESULT" = success/,
  );
  assert.doesNotMatch(job(ci, "real-asr"), /needs: storage-admission/);
  assert.match(
    job(ci, "repository"),
    /github.event.pull_request.number != 100 \|\| needs.storage-admission.result == 'success'/,
  );
  assert.match(job(ci, "seaweedfs-product"), /github.event.pull_request.number == 100/);
});
test("B-3 every checkout discards credentials and workflows remove Actions write", async () => {
  for (const name of ["ci", "e2e", "supply-chain"]) {
    const text = await read(`.github/workflows/${name}.yml`);
    assert.doesNotMatch(text, /actions: write/);
    const checkouts = text
      .split(/ {6}- (?:name:[^\n]*\n {8})?uses: actions\/checkout@[^\n]+\n/)
      .slice(1);
    assert.ok(checkouts.length > 0);
    for (const block of checkouts)
      assert.match(block.split(/\n {6}- /)[0], /persist-credentials: false/);
  }
  const walking = job(await read(".github/workflows/e2e.yml"), "walking-skeleton");
  assert.doesNotMatch(walking, /^ {4}env:/m);
  assert.doesNotMatch(walking, /actions: read/);
});
for (const scenario of [
  "regular",
  "timestamp-pax",
  "symlink",
  "global-path-pax",
  "local-linkpath-pax",
])
  test(`B-2 actual image parser ${scenario}`, async () => {
    const source = await read("infra/seaweedfs/verify-image.sh"),
      prefix = source.split("<<'PY'\n")[1].split("\nbase,bc,")[0];
    const dir = await mkdtemp(path.join(root, ".local/qa-repairs-20261103/parser-"));
    const program = `import io,json,tarfile,hashlib,sys\nfrom pathlib import Path\nscenario=sys.argv.pop();ns={}\nexec(${JSON.stringify(prefix)},ns)\nw=Path(sys.argv[2])\ndef layer(entries,pax=None):\n b=io.BytesIO()\n with tarfile.open(fileobj=b,mode='w',format=tarfile.PAX_FORMAT,pax_headers=pax) as t:\n  for name,body,link in entries:\n   e=tarfile.TarInfo(name);e.mode=0o755\n   if link:e.type=tarfile.SYMTYPE;e.linkname=link\n   else:e.size=len(body)\n   t.addfile(e,None if link else io.BytesIO(body))\n return b.getvalue()\nbase=layer([('usr/bin/weed',b'\\x7fELFtrusted',None),('usr/local/bin/editagent-entrypoint.sh',b'trusted',None)])\nlayers=[base]\nif scenario=='symlink':layers.append(layer([('usr/bin/weed',b'', '/data/weed')]))\nif scenario=='global-path-pax':layers.append(layer([('usr/local/bin/editagent-entrypoint.sh',b'bad',None)],{'path':'usr/share/editagent-seaweedfs/LICENSE.go.txt'}))\nif scenario=='local-linkpath-pax':layers.append(layer([('usr/bin/weed',b'bad',None)],{'linkpath':'/outside'}))\nif scenario=='timestamp-pax':layers=[layer([('usr/bin/weed',b'\\x7fELFtrusted',None),('usr/local/bin/editagent-entrypoint.sh',b'trusted',None)],{'mtime':'123.25'})]\nconfig=json.dumps({'architecture':'amd64','os':'linux','rootfs':{'diff_ids':['sha256:'+hashlib.sha256(b).hexdigest() for b in layers]}}).encode();cn=hashlib.sha256(config).hexdigest()+'.json'\nwith tarfile.open(w/'image.tar','w') as t:\n for n,b in [(cn,config),('manifest.json',json.dumps([{'Config':cn,'Layers':[f'{i}/layer.tar' for i in range(len(layers))]}]).encode())]+[(f'{i}/layer.tar',b) for i,b in enumerate(layers)]:\n  e=tarfile.TarInfo(n);e.size=len(b);t.addfile(e,io.BytesIO(b))\nfiles,data,*_=ns['image'](w/'image.tar',True)\nassert data['usr/bin/weed']==b'\\x7fELFtrusted'\nassert files['usr/local/bin/editagent-entrypoint.sh'][0] in ('0','\\x00')\nprint('PARSER_PASS')`;
    try {
      const r = spawnSync(
        python,
        ["-c", program, path.join(dir, "image.tar"), dir, root, scenario],
        { encoding: "utf8", timeout: 15000 },
      );
      if (["regular", "timestamp-pax"].includes(scenario)) assert.equal(r.status, 0, r.stderr);
      else {
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /not a final regular file|unsupported layer PAX/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
test("B-2 inspection reports record consistency rather than invented build execution", async () => {
  const s = await read("infra/seaweedfs/verify-image.sh");
  assert.doesNotMatch(s, /'reproducible_elf':True/);
  assert.match(s, /two-record-consistency-only; native-independent-builds-required/);
});
test("B-6 receipt paths cannot target arbitrary files outside admission scratch", () => {
  const base = path.join(root, ".local/issue99/admission-abcd");
  assert.doesNotThrow(() =>
    validateReceiptPaths({
      bundle: path.join(base, "bundle"),
      archive: path.join(base, "image.tar"),
    }),
  );
  for (const r of [
    { bundle: "/etc", archive: "/etc/image.tar" },
    { bundle: path.join(base, "bundle"), archive: path.join(base, "../image.tar") },
    { bundle: path.join(base, "other"), archive: path.join(base, "image.tar") },
  ])
    assert.throws(() => validateReceiptPaths(r));
});
test("B-7 JSON numeric spelling cannot bypass exact byte authentication", () => {
  const a = Buffer.from('{"id":5}'),
    b = Buffer.from('{"id":5e0}');
  assert.equal(strictJSON(a).id, strictJSON(b).id);
  assert.notEqual(sha256(a), sha256(b));
});
for (const kind of ["incomplete", "duplicate", "drift"])
  test(`B-8 actual API pagination rejects ${kind}`, async () => {
    const saved = globalThis.fetch;
    let n = 0;
    globalThis.fetch = async () => {
      n++;
      const value =
        kind === "incomplete"
          ? { total_count: 2, jobs: [{ id: 1 }] }
          : kind === "duplicate"
            ? { total_count: 2, jobs: [{ id: 1 }, { id: 1 }] }
            : {
                total_count: n === 1 ? 101 : 102,
                jobs: Array.from({ length: n === 1 ? 100 : 2 }, (_, i) => ({
                  id: n === 1 ? i + 1 : 101 + i,
                })),
              };
      return new Response(JSON.stringify(value), { status: 200 });
    };
    try {
      await assert.rejects(
        () => pages("actions/runs/10/attempts/1/jobs", "jobs", true),
        /POLICY_PAGE_INCOMPLETE|POLICY_PAGE_DUPLICATE/,
      );
    } finally {
      globalThis.fetch = saved;
    }
  });
test("B-8 custom Action changes trigger Walking qualification", async () =>
  assert.match(await read(".github/workflows/e2e.yml"), /\.github\/actions\/\*\*/));
for (const signal of ["HUP", "INT", "TERM"])
  test(`B-8 actual FFmpeg ${signal} trap exits and removes partial bytes`, async () => {
    const dir = await mkdtemp(path.join(root, ".local/qa-repairs-20261103/signal-"));
    const traps = (await read("workers/media-worker/build-ffmpeg.sh"))
      .split("\n")
      .filter((l) => l.startsWith("trap "))
      .join("\n");
    const sh = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "sh";
    try {
      const r = spawnSync(
        sh,
        [
          "-c",
          `set -eu; cd -- "$1"; archive=ffmpeg-7.1.5.tar.xz; touch "$archive.part";\n${traps}\nkill -${signal} $$; echo UNSAFE_CONTINUATION`,
          "test",
          dir,
        ],
        { encoding: "utf8", timeout: 5000 },
      );
      assert.equal(r.status, { HUP: 129, INT: 130, TERM: 143 }[signal], r.stderr);
      assert.doesNotMatch(r.stdout, /UNSAFE_CONTINUATION/);
      await assert.rejects(() => readFile(path.join(dir, "ffmpeg-7.1.5.tar.xz.part")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

test("B-2 image ELF must match independent registry pin, never a self-reported digest", () => {
  const binding = { expected_elf_sha256: "e".repeat(64) };
  assert.doesNotThrow(() => verifyApprovedELF("e".repeat(64), binding));
  assert.throws(() => verifyApprovedELF("f".repeat(64), binding), /PROTECTED_ELF_IDENTITY_DRIFT/);
  assert.throws(() => verifyApprovedELF("e".repeat(64), {}));
});
