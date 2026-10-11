/** Image/build-time bundle. Runtime never bundles or downloads a browser. */
import { bundle } from "@remotion/bundler";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, rename, writeFile } from "node:fs/promises";
import path from "node:path";
async function main() {
  const destination = path.join(__dirname, "../bundle");
  const temp = await mkdtemp(path.join(__dirname, "../.bundle-"));
  try {
    const started = performance.now();
    let bundleInvocationCount = 0;
    bundleInvocationCount++;
    await bundle({
      entryPoint: path.resolve(__dirname, "../../src/composition/index.tsx"),
      outDir: temp,
      enableCaching: false,
      // TypeScript NodeNext spells local imports .js; resolve their repository-owned TS sources.
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...config.resolve,
          extensionAlias: { ...config.resolve?.extensionAlias, ".js": [".js", ".ts", ".tsx"] },
        },
      }),
    });
    const hash = createHash("sha256");
    async function visit(dir: string) {
      for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await visit(file);
        else {
          const name = path.relative(temp, file).split(path.sep).join("/");
          const content = await readFile(file);
          hash.update(JSON.stringify([name, content.length]));
          hash.update(content);
        }
      }
    }
    await visit(temp);
    // Encoding, validation and staging changes also require a new application identity.
    async function runtime(dir: string, label: string, root = dir) {
      for (const item of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (item.name === "bundle" || item.name.startsWith(".bundle-")) continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await runtime(file, label, root);
        else if (/\.(js|json)$/.test(item.name) && !item.name.endsWith(".test.js")) {
          const content = await readFile(file);
          hash.update(
            JSON.stringify([
              label + "/" + path.relative(root, file).split(path.sep).join("/"),
              content.length,
            ]),
          );
          hash.update(content);
        }
      }
    }
    await runtime(path.join(__dirname, ".."), "render-worker");
    const repository = path.resolve(__dirname, "../../../..");
    for (const name of ["domain", "shared", "schemas", "media-core", "job-queue"])
      await runtime(path.join(repository, "packages", name, "dist"), "packages/" + name);
    for (const file of [
      "pnpm-lock.yaml",
      "workers/render-worker/Dockerfile",
      "workers/media-worker/build-ffmpeg.sh",
    ])
      hash.update(await readFile(path.join(repository, file)));
    const renderVersion = hash.digest("hex");
    await writeFile(
      path.join(temp, "catalog.json"),
      JSON.stringify({
        renderVersion,
        compositions: ["FixtureV1", "TimelineV1"],
        bundleInvocationCount,
      }) + "\n",
    );
    await rm(destination, { recursive: true, force: true });
    await rename(temp, destination);
    console.log(
      `Remotion build-time bundle: ${renderVersion}; invocations=${bundleInvocationCount}; durationMs=${Math.round(performance.now() - started)}`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => {
  console.error(
    "Render bundle build failed.",
    error instanceof Error ? error.message.slice(0, 4096) : "Unknown build failure.",
  );
  process.exitCode = 1;
});
