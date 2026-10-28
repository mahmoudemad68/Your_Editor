import assert from "node:assert/strict";
import { URL } from "node:url";

/** Constructed timing, actual bundled component. Public renderStill/renderMedia
 * remain the pixel qualification. This pinned Remotion bridge also tests live
 * DOM anchors across its initial portal move and same-frame requests. */
export async function captionPortalRegression(browser, serveUrl) {
  const context = await browser.newContext({
    viewport: { width: 720, height: 1280 },
    deviceScaleFactor: 1,
  });
  let externalRequests = 0;
  try {
    const page = await context.newPage();
    const props = {
      width: 720,
      height: 1280,
      fps: 25,
      durationInFrames: 75,
      plan: {
        clips: [],
        timing: {
          width: 720,
          height: 1280,
          frameRate: { numerator: 25, denominator: 1 },
          durationInFrames: 75,
        },
        captionsV1: [
          {
            captionId: "018fe277-6ec0-7000-8000-000000000001",
            sourceClipId: "018fe277-6ec0-7000-8000-000000000002",
            startUs: "0",
            endUs: "2000000",
            style: {
              color: "#ffffff",
              background: "#000000",
              highlight: "#ffff00",
              outline: "#000000",
              outlinePx: 0,
              shadowPx: 0,
              font: "DejaVu Sans",
              fontSize: 28,
              direction: "auto",
              preset: "vertical",
              marginPermille: 0,
            },
            lines: [
              [
                { text: "Alpha", startUs: "0", endUs: "500000", confidence: null },
                { text: "Beta", startUs: "500000", endUs: "1000000", confidence: null },
              ],
            ],
          },
        ],
      },
      assets: [],
      components: [],
      background: "#000000",
      captionStyle: { color: "#ffffff", background: "#000000", fontSize: 28, direction: "auto" },
    };
    // Same initialization/selection bridge as pinned renderer setPropsAndEnv.
    await page.addInitScript((data) => {
      globalThis.process = { env: { NODE_ENV: "production" } };
      Object.assign(globalThis, {
        remotion_puppeteerTimeout: 30000,
        remotion_isMainTab: true,
        remotion_mediaCacheSizeInBytes: 67108864,
        remotion_initialMemoryAvailable: 536870912,
        remotion_sampleRate: 48000,
        remotion_broadcastChannel: new globalThis.BroadcastChannel(
          "remotion-video-frame-extraction",
        ),
        remotion_inputProps: JSON.stringify(data),
        remotion_initialFrame: 15,
        remotion_attempt: 1,
        remotion_proxyPort: null,
        remotion_audioEnabled: false,
        remotion_videoEnabled: true,
        remotion_logLevel: "error",
        remotion_envVariables: "{}",
      });
    }, props);
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === new URL(serveUrl).origin)
        return route.continue();
      externalRequests++;
      return route.abort();
    });
    await page.goto(serveUrl);
    await page.waitForFunction(() => typeof globalThis.remotion_setBundleMode === "function");
    await page.evaluate(
      (data) =>
        globalThis.remotion_setBundleMode({
          type: "composition",
          compositionName: "TimelineV1",
          serializedResolvedPropsWithSchema: JSON.stringify(data),
          compositionDurationInFrames: 75,
          compositionFps: 25,
          compositionHeight: 1280,
          compositionWidth: 720,
        }),
      props,
    );
    await page.locator("[data-caption-component]").waitFor({ state: "attached" });
    const rows = [];
    for (const frame of [15, 15, 0, 15, 25, 50, 15]) {
      await page.evaluate((f) => globalThis.remotion_setFrame(f, "TimelineV1", 0), frame);
      await page.waitForFunction(() => globalThis.remotion_renderReady === true);
      const expected = frame === 0 ? "Alpha" : frame === 15 ? "Beta" : null;
      const result = await page.evaluate(
        ({ frame, expected }) => {
          const { document, CSS } = globalThis;
          const root = document.querySelector("[data-caption-text]"),
            ranges = [...CSS.highlights.values()].flatMap((h) => [...h]);
          return {
            frame,
            visible: Boolean(root),
            rangeCount: ranges.length,
            exactNativeWord:
              expected === null
                ? ranges.length === 0
                : ranges.length === 1 && ranges[0].toString() === expected,
            anchorsInVisibleText: ranges.every(
              (r) => root?.contains(r.startContainer) && root?.contains(r.endContainer),
            ),
            pendingRenderHandles: Object.keys(globalThis.remotion_delayRenderTimeouts ?? {}).length,
          };
        },
        { frame, expected },
      );
      assert.equal(result.visible, frame !== 50);
      assert.equal(result.exactNativeWord, true, `Native caption range differs at frame ${frame}`);
      assert.equal(result.anchorsInVisibleText, true);
      assert.equal(result.pendingRenderHandles, 0);
      rows.push(result);
    }
    assert.equal(externalRequests, 0);
    return {
      status: "PASS",
      evidence: "constructed timing; actual bundled DOM, not speech accuracy",
      externalRequests,
      frames: rows,
    };
  } finally {
    await context.close();
  }
}
