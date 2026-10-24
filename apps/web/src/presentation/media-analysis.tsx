"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  failureDetail,
  parseAnalysisFailureDetails,
  type AnalysisFailureDetails,
  type parseMediaAnalysis,
} from "@editagent/schemas";
import type { ApiResult } from "../project-contract";
import { request } from "./browser-project-api";
import { Button } from "./ui/button";

type Analysis = ReturnType<typeof parseMediaAnalysis>;
type Loader = (project: string, media: string, signal: AbortSignal) => Promise<ApiResult<Analysis>>;
const loadAnalysis: Loader = (project, media, signal) =>
  request<Analysis>(
    `/api/projects/${encodeURIComponent(project)}/media/${encodeURIComponent(media)}/analysis`,
    { signal },
  );
type FailureLoader = (
  project: string,
  media: string,
  signal: AbortSignal,
) => Promise<ApiResult<AnalysisFailureDetails>>;
const loadFailureDetails: FailureLoader = (project, media, signal) =>
  request<AnalysisFailureDetails>(
    `/api/projects/${encodeURIComponent(project)}/media/${encodeURIComponent(media)}/analysis/failures`,
    { signal },
  );

export function MediaAnalysisPanel({
  projectId,
  mediaId,
  load = loadAnalysis,
  loadFailures,
}: {
  projectId: string;
  mediaId: string;
  load?: Loader;
  loadFailures?: FailureLoader;
}) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failures, setFailures] = useState<AnalysisFailureDetails | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    setAnalysis(null);
    setFailures(null);
    setError(null);
    try {
      const result = await load(projectId, mediaId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.ok) {
        const detailsLoader =
          loadFailures ?? (load === loadAnalysis ? loadFailureDetails : undefined);
        if (detailsLoader) {
          const detail = await detailsLoader(projectId, mediaId, controller.signal);
          if (controller.signal.aborted) return;
          if (!detail.ok && [401, 403, 404].includes(detail.status)) {
            setError("Analysis is not available.");
            return;
          }
          if (detail.ok) {
            const validated = parseAnalysisFailureDetails(detail.data);
            if (
              validated.mediaAssetId !== mediaId ||
              validated.sourceSha256 !== result.data.source.sha256
            )
              throw new Error("Stale analysis details");
            setFailures(validated);
          }
        }
        setAnalysis(result.data);
      } else setError(result.message);
    } catch {
      if (!controller.signal.aborted) setError("Analysis could not be loaded. Try again.");
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [load, loadFailures, projectId, mediaId]);
  useEffect(() => {
    void refresh();
    return () => active.current?.abort();
  }, [refresh]);
  const transcript = analysis?.sections.transcript;
  const failureMessage = (analyzer: "audio" | "transcript", fallback: string) => {
    const detail = failures?.failures.find(
      (entry) =>
        entry.analyzer === analyzer || (analyzer === "audio" && entry.analyzer === "speech"),
    );
    return detail ? failureDetail(detail.category).message : fallback;
  };
  return (
    <section aria-label="Media analysis" className="mt-4 border-t border-line pt-3">
      <h4 className="text-sm font-semibold">Analysis</h4>
      <Button
        variant="secondary"
        className="mt-2"
        disabled={loading}
        onClick={() => void refresh()}
      >
        Refresh analysis
      </Button>
      {loading ? (
        <p aria-busy="true" className="mt-2 text-sm text-muted">
          Loading analysis…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {analysis ? (
        <>
          <dl className="mt-3 text-sm">
            <div>
              <dt className="inline">Transcript: </dt>
              <dd className="inline">{transcript?.status}</dd>
            </div>
            <div>
              <dt className="inline">Audio: </dt>
              <dd className="inline">{analysis.sections.audio.status}</dd>
            </div>
          </dl>
          {transcript?.status === "failed" ? (
            <p className="mt-2 text-sm text-danger">
              {failureMessage("transcript", transcript.failure.reason)}
            </p>
          ) : null}
          {analysis.sections.audio.status === "failed" ? (
            <p className="mt-2 text-sm text-danger">
              {failureMessage("audio", analysis.sections.audio.failure.reason)}
            </p>
          ) : null}
          {transcript?.status === "completed" ? (
            <div className="mt-3 max-h-80 overflow-y-auto" aria-label="Transcript" dir="auto">
              <p className="mb-2 text-xs text-muted">Language: {transcript.data.language}</p>
              {transcript.data.segments.length === 0 ? (
                <p>No speech was detected.</p>
              ) : (
                transcript.data.segments.map((segment) => (
                  <p key={segment.id} className="mb-2 text-sm" dir="auto">
                    {segment.text}
                  </p>
                ))
              )}
            </div>
          ) : transcript?.status === "not_available" ? (
            <p className="mt-2 text-sm text-muted">Transcript is not available yet.</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
