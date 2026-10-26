/** Deterministic test scenario, not language understanding or a live provider.
 * Generated replies go through the real replay port, plan validator and SDK. */
import { createHash } from "node:crypto";
import type { TimelineSnapshot } from "@editagent/domain";
import { contentHash } from "@editagent/tool-sdk";
import {
  ReplayProvider,
  ProviderError,
  requestHash,
  isolatedJson,
  stepInput,
  protocolToolName,
  type LanguageModel,
  type ModelRequest,
  type ProviderCapabilities,
  type ModelReply,
} from "@editagent/agent-core";
import type { EditPlanV1 } from "@editagent/schemas";

export const qualificationCapabilities: ProviderCapabilities = {
  schemaVersion: "1.0.0",
  provider: "replay",
  modelId: "qualification-replay",
  modelVersion: "1.0.0",
  contextWindow: 65536,
  maxOutputTokens: 4096,
  modes: ["structured", "tools"],
  tokenizer: { kind: "conservative_utf8_bytes", version: "1" },
  evidence: "synthetic_replay",
  configurationVersion: "fixture-v1",
  pricing: {
    version: "synthetic-zero-v1",
    provenance: "synthetic_fixture",
    inputMicrosPerMillionTokens: 0,
    outputMicrosPerMillionTokens: 0,
  },
};
export type QualificationScenario =
  | "success"
  | "bad-plan-once"
  | "bad-tool-once"
  | "invalid-always"
  | "blocked"
  | "unavailable"
  | "unknown"
  | "refused";
export function qualificationModel(
  snapshot: TimelineSnapshot,
  scenario: QualificationScenario = "success",
  observed?: () => void,
  capabilities = qualificationCapabilities,
): LanguageModel {
  let invalidPlanSent = false,
    invalidToolSent = false;
  const invoke = async (
    mode: "structured" | "tools",
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelReply> => {
    observed?.();
    if (scenario === "blocked")
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new ProviderError("cancelled"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    if (scenario === "unavailable") throw new ProviderError("unavailable");
    if (scenario === "unknown") throw new ProviderError("transport_unknown");
    if (scenario === "refused") throw new ProviderError("refused");
    const envelope = JSON.parse(request.messages.at(-1)!.content) as {
      context: {
        prompt: { provenance: { promptId: string; promptVersion: string; templateHash: string } };
      };
      trustedRuntime: { plannedStep: EditPlanV1["steps"][number] | null };
    };
    const clip = snapshot.tracks[0]!.clips[0]!,
      asset = snapshot.sources[0]!;
    const p = envelope.context.prompt.provenance;
    const plan: EditPlanV1 = {
      schemaVersion: "1.0.0",
      projectId: snapshot.projectId,
      timelineId: snapshot.id,
      sourceSha256: contentHash(snapshot),
      coordinateSystem: "original_timeline_microseconds",
      goals: ["trim", "split"],
      targetDurationUs: snapshot.composition.durationUs,
      selectedMedia: [asset.id],
      segments: [{ assetId: asset.id, startUs: "0", endUs: asset.durationUs }],
      steps: [
        {
          id: "trim",
          tool: "editing.trim-video",
          version: "1.0.0",
          dependencies: [],
          clipId: clip.id,
          startUs: "200000",
          endUs: "1800000",
          atUs: "0",
        },
        {
          id: "split",
          tool: "editing.split-video",
          version: "1.0.0",
          dependencies: ["trim"],
          clipId: clip.id,
          startUs: "0",
          endUs: "0",
          atUs: "1000000",
        },
      ],
      provenance: {
        contextSha256: createHash("sha256").update(isolatedJson(envelope.context)).digest("hex"),
        promptId: p.promptId,
        promptVersion: p.promptVersion,
        templateHash: p.templateHash,
        dataAuthority: "untrusted_model_proposal",
      },
      stopCriteria: { afterSteps: 2, render: true, validateOutput: true },
    };
    let structured: unknown = mode === "structured" ? plan : null;
    if (scenario === "invalid-always" || (scenario === "bad-plan-once" && !invalidPlanSent)) {
      structured = { ...plan, sourceSha256: "f".repeat(64) };
      invalidPlanSent = true;
    }
    const step = envelope.trustedRuntime.plannedStep;
    let args = step ? stepInput(step) : null;
    if (step && scenario === "bad-tool-once" && !invalidToolSent) {
      args = { clipId: clip.id, atUs: "9999999999" };
      invalidToolSent = true;
    }
    return new ReplayProvider(capabilities, [
      {
        mode,
        requestSha256: requestHash(mode, request),
        reply: {
          text: null,
          structured,
          calls: step
            ? [
                {
                  idSha256: contentHash({ step: step.id }),
                  name: protocolToolName(step.tool),
                  arguments: args,
                },
              ]
            : [],
        },
        syntheticUsage: { inputTokens: 17, outputTokens: 23 },
      },
    ])[mode](request, signal);
  };
  const unsupported = async (_r: ModelRequest, _s: AbortSignal): Promise<ModelReply> => {
    throw new ProviderError("unsupported_mode");
  };
  return {
    capabilities,
    chat: unsupported,
    vision: unsupported,
    structured: (r, s) => invoke("structured", r, s),
    tools: (r, s) => invoke("tools", r, s),
  };
}
