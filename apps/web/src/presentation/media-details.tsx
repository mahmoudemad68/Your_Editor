"use client";

import type { MediaDetails } from "../project-contract";
import { Button } from "./ui/button";

/** Technical metadata from GET media details. Null fields stay unavailable. */
export function MediaDetailsPanel({
  details,
  refreshing,
  onRefresh,
}: {
  details: MediaDetails;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const pending = details.inspectionStatus === "pending";
  const failed = details.inspectionStatus === "failed";
  return (
    <section className="mt-6 min-w-0 rounded-lg border border-line bg-panel p-4" aria-live="polite">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Media details</h2>
        <Button variant="secondary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Refreshing…" : "Refresh details"}
        </Button>
      </div>
      <p className="overflow-anywhere mt-2 text-sm text-muted">
        {details.displayFilename ?? "Unavailable"}
      </p>
      <p className="mt-2 text-sm">
        Inspection <span className="text-paper">{details.inspectionStatus}</span>
      </p>
      {pending ? (
        <p className="mt-2 max-w-xl text-sm text-muted">
          Inspection is pending. Automatic inspection arrives with background jobs. Refresh after an
          inspection has been recorded.
        </p>
      ) : null}
      {failed ? (
        <p className="overflow-anywhere mt-2 text-sm text-danger" role="alert">
          {failureText(details.inspectionError)}
        </p>
      ) : null}
      <dl className="mt-4 grid min-w-0 gap-2 text-sm sm:grid-cols-2">
        <Detail label="Container" value={details.container} />
        <Detail label="Video codec" value={details.videoCodec} />
        <Detail label="Audio codec" value={details.audioCodec} />
        <Detail label="Stored resolution" value={resolution(details.width, details.height)} />
        <Detail
          label="Display resolution"
          value={resolution(details.displayWidth, details.displayHeight)}
        />
        <Detail label="Rotation" value={details.rotation} />
        <Detail
          label="Frame rate"
          value={frameRate(details.frameRateNumerator, details.frameRateDenominator)}
        />
        <Detail label="Frame-rate mode" value={details.frameRateMode} />
        <Detail label="Duration (microseconds)" value={details.duration} />
        <Detail label="Color space" value={details.colorSpace} />
        <Detail label="Audio channels" value={details.audioChannels} />
        <Detail label="Sample rate" value={details.sampleRate} />
      </dl>
      <h3 className="mt-4 text-sm font-semibold">Streams</h3>
      {details.streams === null || details.streams.length === 0 ? (
        <p className="mt-2 text-sm text-muted">Unavailable</p>
      ) : (
        <ul className="mt-2 min-w-0 space-y-2">
          {details.streams.map((stream, index) => (
            <li
              key={`${stream.codecType}-${index}`}
              className="overflow-anywhere text-sm text-muted"
            >
              {stream.codecType} {shown(stream.codecName)}
              {stream.width !== null && stream.height !== null
                ? ` ${stream.width}x${stream.height}`
                : ""}
              {stream.channels !== null ? ` ${stream.channels} ch` : ""}
              {stream.sampleRate !== null ? ` ${stream.sampleRate} Hz` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="overflow-anywhere text-paper">{shown(value)}</dd>
    </div>
  );
}

function shown(value: string | number | null): string {
  if (value === null || value === "") {
    return "Unavailable";
  }
  return String(value);
}

function resolution(width: number | null, height: number | null): string | null {
  if (width === null || height === null) {
    return null;
  }
  return `${width}×${height}`;
}

function frameRate(numerator: string | null, denominator: string | null): string | null {
  if (numerator === null || denominator === null) {
    return null;
  }
  return `${numerator}/${denominator}`;
}

function failureText(error: string | null): string {
  if (error === null || error.length === 0 || error.length > 80 || error.includes("\n")) {
    return "Inspection failed.";
  }
  return `Inspection failed: ${error}`;
}
