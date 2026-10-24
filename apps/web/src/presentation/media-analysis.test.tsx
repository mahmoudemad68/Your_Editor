import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { failureDetail, parseMediaAnalysis } from "@editagent/schemas";
import { analysisFixture, ANALYSIS_MEDIA, ANALYSIS_PROJECT } from "../analysis-test-fixture";
import { MediaAnalysisPanel } from "./media-analysis";

test("completed EN/AR transcript remains visible when audio analysis fails, for both schema versions", async () => {
  for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
    cleanup();
    render(
      <MediaAnalysisPanel
        projectId={ANALYSIS_PROJECT}
        mediaId={ANALYSIS_MEDIA}
        load={async () => ({ ok: true, data: parseMediaAnalysis(analysisFixture(version)) })}
      />,
    );
    await screen.findByText("Hello مرحبا");
    assert.ok(screen.getByText("Analysis timed out."));
    assert.ok(screen.getByText("completed"));
    assert.equal(screen.getByText("Hello مرحبا").getAttribute("dir"), "auto");
    cleanup();
  }
});

test("local context metadata shows honest unknown/mixed scores without changing transcript text", async () => {
  cleanup();
  const fixture = analysisFixture("1.2.0");
  const common = {
    method: "ct2-source-context-v1",
    scope: "audio_context_not_word_language",
    model: { name: "faster-whisper-small", version: "fixture", sha256: "a".repeat(64) },
  };
  const data = parseMediaAnalysis({
    ...fixture,
    source: { ...fixture.source, durationUs: "6000000" },
    sections: {
      ...fixture.sections,
      transcript: {
        ...fixture.sections.transcript,
        data: {
          ...fixture.sections.transcript.data,
          languageSegments: [
            {
              ...common,
              startUs: "0",
              endUs: "2000000",
              status: "dominant",
              language: "ar",
              confidence: 0.8,
            },
            { ...common, startUs: "2000000", endUs: "4000000", status: "mixed" },
            { ...common, startUs: "4000000", endUs: "6000000", status: "unknown" },
          ],
        },
      },
    },
  });
  render(
    <MediaAnalysisPanel
      projectId={ANALYSIS_PROJECT}
      mediaId={ANALYSIS_MEDIA}
      load={async () => ({ ok: true, data })}
    />,
  );
  await screen.findByText("Hello مرحبا");
  assert.ok(screen.getByText(/ar \(model score 0.80\)/));
  assert.ok(screen.getByText(/mixed \/ uncertain/));
  assert.ok(screen.getByText(/4–6s: unknown/));
  assert.ok(screen.getByText(/these do not label individual words/));
  cleanup();
});

test("refresh removes previously loaded text if authorization is revoked", async () => {
  cleanup();
  let calls = 0;
  render(
    <MediaAnalysisPanel
      projectId={ANALYSIS_PROJECT}
      mediaId={ANALYSIS_MEDIA}
      load={async () =>
        ++calls === 1
          ? { ok: true, data: parseMediaAnalysis(analysisFixture()) }
          : { ok: false, status: 403, message: "You do not have access to this analysis." }
      }
    />,
  );
  await screen.findByText("Hello مرحبا");
  fireEvent.click(screen.getByRole("button", { name: "Refresh analysis" }));
  await screen.findByRole("alert");
  assert.equal(screen.queryByText("Hello مرحبا"), null);
  cleanup();
});

test("unmount aborts in-flight analysis", async () => {
  cleanup();
  let pendingSignal: AbortSignal | undefined;
  const load = async (_project: string, _media: string, signal: AbortSignal) => {
    pendingSignal = signal;
    return new Promise<never>(() => {});
  };
  const view = render(
    <MediaAnalysisPanel projectId={ANALYSIS_PROJECT} mediaId={ANALYSIS_MEDIA} load={load} />,
  );
  await waitFor(() => assert.ok(pendingSignal));
  view.unmount();
  assert.equal(pendingSignal?.aborted, true);
  cleanup();
});

test("safe alignment detail is actionable and upstream text never renders", async () => {
  cleanup();
  const fixture = analysisFixture() as ReturnType<typeof analysisFixture>;
  const analysis = parseMediaAnalysis(fixture);
  analysis.sections.transcript = {
    status: "failed",
    failure: { code: "unsupported", reason: "This analysis is unsupported.", retryable: false },
  };
  render(
    <MediaAnalysisPanel
      projectId={ANALYSIS_PROJECT}
      mediaId={ANALYSIS_MEDIA}
      load={async () => ({ ok: true, data: analysis })}
      loadFailures={async () => ({
        ok: true,
        data: {
          mediaAssetId: ANALYSIS_MEDIA,
          sourceSha256: analysis.source.sha256,
          failures: [
            {
              analyzer: "transcript",
              ...failureDetail("untrustworthy_alignment"),
              message: "private transcript" as never,
            },
          ],
        },
      })}
    />,
  );
  await screen.findByText(/Trustworthy word timing could not be established/);
  assert.equal(screen.queryByText("private transcript"), null);
  cleanup();
});

test("revocation during companion read cannot display already fetched transcript", async () => {
  cleanup();
  render(
    <MediaAnalysisPanel
      projectId={ANALYSIS_PROJECT}
      mediaId={ANALYSIS_MEDIA}
      load={async () => ({ ok: true, data: parseMediaAnalysis(analysisFixture()) })}
      loadFailures={async () => ({ ok: false, status: 404, message: "private resource" })}
    />,
  );
  await screen.findByText("Analysis is not available.");
  assert.equal(screen.queryByText("Hello مرحبا"), null);
  cleanup();
});
