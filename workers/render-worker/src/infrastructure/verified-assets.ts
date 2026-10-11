import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { RenderInput, VerifiedAsset } from "../application/ports.js";
import { fileSha } from "./storage.js";
/** Independent executor validation; only exact content-bound filenames become HTTP routes. */
export async function verifyStagedAssets(
  input: RenderInput,
  raw: unknown,
  work: string,
  signal: AbortSignal,
): Promise<VerifiedAsset[]> {
  const sources = input.compositionId === "TimelineV1" ? input.props.timeline.sources : [];
  if (!Array.isArray(raw) || raw.length !== sources.length)
    throw new Error("Invalid staged asset set.");
  const ids = new Set<string>();
  let total = 0;
  const assets: VerifiedAsset[] = [];
  for (const value of raw) {
    if (
      !value ||
      typeof value !== "object" ||
      Object.keys(value).sort().join(",") !== "byteSize,durationUs,kind,name,sha256,sourceId"
    )
      throw new Error("Invalid staged identity.");
    const a = value as VerifiedAsset;
    const s = sources.find((s) => s.id === a.sourceId);
    total += a.byteSize;
    if (
      !s ||
      ids.has(a.sourceId) ||
      a.kind !== s.kind ||
      a.durationUs !== s.durationUs ||
      !/^[a-f0-9]{64}$/.test(a.sha256) ||
      !/^[a-f0-9]{64}\.(mp4|wav|png|jpg)$/.test(a.name) ||
      !a.name.startsWith(a.sha256 + ".") ||
      !Number.isSafeInteger(a.byteSize) ||
      a.byteSize < 1 ||
      total > 536870912
    )
      throw new Error("Invalid staged identity.");
    const file = path.join(work, a.name),
      st = await lstat(file);
    if (
      !st.isFile() ||
      st.size !== a.byteSize ||
      (await realpath(file)) !== file ||
      (await fileSha(file, signal)) !== a.sha256
    )
      throw new Error("Staged asset checksum mismatch.");
    ids.add(a.sourceId);
    assets.push(a);
  }
  return assets;
}
