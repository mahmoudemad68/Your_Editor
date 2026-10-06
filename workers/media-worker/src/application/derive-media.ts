import {
  DerivedAsset,
  type DerivedArtifact,
  type MediaAsset,
  type MediaAssetId,
  type Instant,
} from "@editagent/domain";
import { derivativePlans, canonicalJson, type DerivativePlan } from "./derivative-plan.js";
import { type MediaObjectStaging } from "./inspect-media.js";
import { PermanentJobError } from "./job-errors.js";

export interface DerivedAssetStore {
  loadSource(id: MediaAssetId, projectId: string): Promise<MediaAsset | null>;
  findBySignature(id: MediaAssetId, kind: string, signature: string): Promise<DerivedAsset | null>;
  listByMediaAsset(id: MediaAssetId, projectId: string): Promise<readonly DerivedAsset[]>;
  save(asset: DerivedAsset): Promise<DerivedAsset>;
}
export interface DerivationRepository extends DerivedAssetStore {
  withSourceLock<T>(
    id: MediaAssetId,
    signal: AbortSignal,
    work: (store: DerivedAssetStore) => Promise<T>,
  ): Promise<T>;
}
export interface DerivativeObjects {
  find(
    source: MediaAsset,
    plan: DerivativePlan,
    signal: AbortSignal,
  ): Promise<DerivedArtifact | null>;
  put(
    source: MediaAsset,
    plan: DerivativePlan,
    output: GeneratedDerivative,
    signal: AbortSignal,
  ): Promise<DerivedArtifact>;
}
export interface GeneratedDerivative {
  readonly filePath: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}
export interface PreparedDerivatives {
  generate(plan: DerivativePlan, signal: AbortSignal): Promise<GeneratedDerivative>;
  release(): Promise<void>;
}
export interface MediaDerivativeProcessor {
  prepare(
    source: MediaAsset,
    stagedPath: string,
    signal: AbortSignal,
  ): Promise<PreparedDerivatives>;
}
/** US-127 can replace the temporary operator gate without changing processing. */
export interface DerivationGate {
  assertAllowed(source: MediaAsset, signal: AbortSignal): Promise<void>;
}
export interface DerivationDependencies {
  readonly repository: DerivationRepository;
  readonly objects: DerivativeObjects;
  readonly staging: MediaObjectStaging;
  readonly processor: MediaDerivativeProcessor;
  readonly gate: DerivationGate;
  readonly now: () => Instant;
  readonly newId: () => string;
  readonly onStage?: (stage: string) => void | Promise<void>;
}

export async function deriveMediaAsset(
  id: MediaAssetId,
  projectId: string,
  signal: AbortSignal,
  deps: DerivationDependencies,
): Promise<readonly DerivedAsset[]> {
  return deps.repository.withSourceLock(id, signal, async (store) => {
    signal.throwIfAborted();
    const source = await store.loadSource(id, projectId);
    if (source === null) throw new PermanentJobError("Derivation source is unavailable.");
    await deps.gate.assertAllowed(source, signal);
    const plans = derivativePlans(source);
    const results: DerivedAsset[] = [];
    let staged: Awaited<ReturnType<MediaObjectStaging["stage"]>> | undefined;
    let processor: PreparedDerivatives | undefined;
    try {
      for (const plan of plans) {
        signal.throwIfAborted();
        const existing = await store.findBySignature(id, plan.kind, plan.signature);
        let object = await deps.objects.find(source, plan, signal);
        if (existing !== null && object !== null) {
          assertSameArtifact(existing.artifact, object);
          results.push(existing);
          continue;
        }
        if (object === null) {
          if (processor === undefined) {
            await deps.onStage?.("staging");
            signal.throwIfAborted();
            staged = await deps.staging.stage(source.storageKey!, signal);
            signal.throwIfAborted();
            if (staged.contentSha256 !== source.contentSha256)
              throw new PermanentJobError("Staged source content identity changed.");
            processor = await deps.processor.prepare(source, staged.filePath, signal);
          }
          await deps.onStage?.(plan.variant);
          const output = await processor.generate(plan, signal);
          signal.throwIfAborted();
          await deps.onStage?.("uploading");
          object = await deps.objects.put(source, plan, output, signal);
        }
        signal.throwIfAborted();
        await deps.onStage?.("finalizing");
        if (existing !== null) {
          assertSameArtifact(existing.artifact, object);
          results.push(existing);
        } else {
          results.push(
            await store.save(
              new DerivedAsset(deps.newId(), id, plan.kind, deps.now(), undefined, object),
            ),
          );
        }
      }
      return results;
    } finally {
      try {
        await processor?.release();
      } finally {
        await staged?.release();
      }
    }
  });
}
function assertSameArtifact(expected: DerivedArtifact | null, actual: DerivedArtifact): void {
  if (expected === null || canonicalJson(expected) !== canonicalJson(actual)) {
    throw new PermanentJobError("Stored derivative identity or metadata conflict.");
  }
}
