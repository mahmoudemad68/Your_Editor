import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("exported trace/logs redact sessions, passwords and signed URLs, preserving failure stages", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "artifact-test-"));
  try {
    const artifacts = path.join(dir, "artifacts");
    mkdirSync(artifacts);
    const secrets = path.join(dir, "secrets.json");
    writeFileSync(secrets, JSON.stringify(["test-password"]));
    writeFileSync(
      path.join(artifacts, "trace.network"),
      JSON.stringify({
        request: {
          headers: [{ name: "cookie", value: "session-value" }],
          postData: { text: '{"password":"test-password"}' },
        },
        url: "https://storage.test/object?X-Amz-Signature=secret",
        data: "test-password",
        status: 503,
        frameSnapshot: [
          "INPUT",
          {
            name: "password",
            type: "password",
            value: "test-password",
            __playwright_value_: "test-password",
          },
        ],
        headerWithExtraField: { name: "cookie", value: "session-value", captured: "test-password" },
      }) + "\n",
    );
    writeFileSync(
      path.join(artifacts, "service.log"),
      'api | {"status":"Failed","url":"http://user:pass@host/path?token=secret","password":"test-password"}\n',
    );
    execFileSync("python3", [
      "-c",
      "import zipfile,sys; p=sys.argv[1]; z=zipfile.ZipFile(p+'/trace.zip','w'); z.write(p+'/trace.network','trace.network'); z.close()",
      artifacts,
    ]);
    execFileSync("python3", [
      "tools/test/sanitize-artifacts.py",
      artifacts,
      "--secret-file",
      secrets,
    ]);
    const zip = execFileSync(
      "python3",
      [
        "-c",
        "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('trace.network').decode())",
        path.join(artifacts, "trace.zip"),
      ],
      { encoding: "utf8" },
    );
    const combined =
      readFileSync(path.join(artifacts, "trace.network"), "utf8") +
      readFileSync(path.join(artifacts, "service.log"), "utf8") +
      zip;
    for (const secret of [
      "session-value",
      "test-password",
      "Signature=secret",
      "user:pass",
      "token=secret",
    ])
      assert.equal(combined.includes(secret), false);
    assert.match(combined, /503/);
    assert.match(combined, /Failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("F32 sanitizer structured, encoded, nested archive and binary regressions", () => {
  execFileSync("python3", ["tests/integration/support/sanitizer-regressions.py"], {
    stdio: "inherit",
  });
});
