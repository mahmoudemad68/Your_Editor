"use client";
import { useEffect, useRef, useState } from "react";
import type { CaptionStyle, EditorTimeline } from "../editor-contract";
import type { ApiResult } from "../project-contract";
import { request } from "./browser-project-api";
import { Button } from "./ui/button";

const uuid = () => {
  const stamp = Date.now().toString(16).padStart(12, "0"),
    r = crypto.randomUUID().replaceAll("-", "");
  return `${stamp.slice(0, 8)}-${stamp.slice(8)}-7${r.slice(13, 16)}-${r.slice(16, 20)}-${r.slice(20)}`;
};
type Api = <T>(url: string, options?: RequestInit) => Promise<ApiResult<T>>;
export function CaptionControls({
  projectId,
  stored,
  assetId,
  disabled,
  onSaved,
  onUnavailable,
  onBusyChange,
  api = request,
}: {
  projectId: string;
  stored: EditorTimeline;
  assetId: string | null;
  disabled: boolean;
  onSaved: (value: EditorTimeline) => void;
  onUnavailable?: () => void;
  onBusyChange?: (busy: boolean) => void;
  api?: Api;
}) {
  const existing = stored.timeline.captionsV1?.find((c) => c.assetId === assetId);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const defaultPreset: CaptionStyle["preset"] =
    stored.timeline.composition.height > stored.timeline.composition.width
      ? "vertical"
      : stored.timeline.composition.height === stored.timeline.composition.width
        ? "square"
        : "landscape";
  const [highlight, setHighlight] = useState(existing?.style.highlight ?? "#ffff00"),
    [direction, setDirection] = useState<CaptionStyle["direction"]>(
      existing?.style.direction ?? "auto",
    ),
    [preset, setPreset] = useState<CaptionStyle["preset"]>(existing?.style.preset ?? defaultPreset);
  useEffect(() => {
    setHighlight(existing?.style.highlight ?? "#ffff00");
    setDirection(existing?.style.direction ?? "auto");
    setPreset(existing?.style.preset ?? defaultPreset);
  }, [
    assetId,
    existing?.id,
    existing?.style.highlight,
    existing?.style.direction,
    existing?.style.preset,
    defaultPreset,
  ]);
  const active = useRef(false);
  const activeController = useRef<AbortController | null>(null);
  useEffect(() => () => activeController.current?.abort(), []);
  const base = `/api/projects/${encodeURIComponent(projectId)}/editor/${encodeURIComponent(stored.timeline.id)}/captions`;
  const style: CaptionStyle = {
    ...(existing?.style ?? {
      color: "#ffffff",
      background: "#000000",
      outline: "#000000",
      outlinePx: 0,
      shadowPx: 1,
      font: "DejaVu Sans",
      fontSize: Math.max(14, Math.min(48, Math.floor(stored.timeline.composition.width * 0.04))),
      marginPermille: 0,
    }),
    highlight,
    direction,
    preset,
  };
  const take = <T,>(r: ApiResult<T>): T => {
    if (!r.ok) {
      if ([401, 403, 404].includes(r.status)) onUnavailable?.();
      throw new Error(r.message);
    }
    return r.data;
  };
  async function edit(operation: "add" | "style" | "undo") {
    if (active.current || !assetId) return;
    active.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    const controller = new AbortController();
    activeController.current = controller;
    try {
      let path = base,
        body: object;
      if (operation === "add") {
        const source = take(
          await api<{ assetId: string; sourceSha256: string; analysisSha256: string }>(
            `${base}/sources/${encodeURIComponent(assetId)}`,
            { signal: controller.signal },
          ),
        );
        body = { ...source, stateSha256: stored.stateSha256, requestId: uuid(), style };
      } else if (operation === "style" && existing) {
        path += `/${encodeURIComponent(existing.id)}/style`;
        body = { stateSha256: stored.stateSha256, requestId: uuid(), style };
      } else {
        const history = take(
          await api<{ id: string; status: string }[]>(`${base}/history`, {
            signal: controller.signal,
          }),
        );
        const last = history.find((h) => h.status === "committed");
        if (!last) throw new Error("No caption command is available to undo.");
        path += `/${encodeURIComponent(last.id)}/undo`;
        body = { stateSha256: stored.stateSha256 };
      }
      const saved = take(
        await api<EditorTimeline>(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
      );
      if (!controller.signal.aborted) onSaved(saved);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "The caption edit could not be completed.");
    } finally {
      active.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <section
      aria-label="Word-synchronized captions"
      className="mt-6 rounded-lg border border-line p-4"
    >
      <h2 className="font-semibold">Word-synchronized captions</h2>
      <p className="mt-2 text-sm text-muted">
        Uses completed Small-model word timing for the selected source. Captions follow retained
        source content. No face tracking is assumed.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <label>
          Safe zone{" "}
          <select
            aria-label="Caption safe zone"
            value={preset}
            onChange={(e) => setPreset(e.target.value as CaptionStyle["preset"])}
          >
            <option value="vertical">9:16 Reel / Short / TikTok</option>
            <option value="square">1:1</option>
            <option value="landscape">16:9</option>
          </select>
        </label>
        <label>
          Direction{" "}
          <select
            aria-label="Caption direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as CaptionStyle["direction"])}
          >
            <option value="auto">Automatic Bidi</option>
            <option value="rtl">Right to left</option>
            <option value="ltr">Left to right</option>
          </select>
        </label>
        <label>
          Active word{" "}
          <input
            aria-label="Caption highlight color"
            type="color"
            value={highlight}
            onChange={(e) => setHighlight(e.target.value)}
          />
        </label>
        <Button
          disabled={disabled || busy || !assetId || Boolean(existing)}
          onClick={() => void edit("add")}
        >
          Add word-synchronized captions
        </Button>
        <Button
          variant="secondary"
          disabled={disabled || busy || !existing}
          onClick={() => void edit("style")}
        >
          Update caption style
        </Button>
        <Button variant="secondary" disabled={disabled || busy} onClick={() => void edit("undo")}>
          Undo last caption edit
        </Button>
      </div>
      {existing ? (
        <p role="status" data-caption-id={existing.id}>
          {existing.blocks.length} saved caption blocks
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
