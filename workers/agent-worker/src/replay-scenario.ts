import { contentHash } from "@editagent/tool-sdk";
import { EditPlanV1Schema, type EditPlanV1 } from "@editagent/schemas";
import {
  ReplayProvider,
  ProviderError,
  checkedCapabilities,
  requestHash,
  stepInput,
  protocolToolName,
  type LanguageModel,
  type ModelRequest,
  type ProviderCapabilities,
  type ModelReply,
  assertControlledReplayPermit,
  type ControlledReplayPermit,
} from "@editagent/agent-core";

/** Explicit deterministic fixture, not language understanding. The approved
 * isolated runner supplies a fixed grounded plan, never a production request. */
export class ControlledReplayScenario implements LanguageModel {
  readonly capabilities: ProviderCapabilities;
  private readonly plan: EditPlanV1;
  constructor(capabilities: ProviderCapabilities, plan: unknown, permit: ControlledReplayPermit) {
    assertControlledReplayPermit(permit);
    this.capabilities = checkedCapabilities(capabilities);
    if (
      this.capabilities.provider !== "replay" ||
      this.capabilities.evidence !== "synthetic_replay"
    )
      throw new ProviderError("invalid_request");
    const parsed = EditPlanV1Schema.safeParse(plan);
    if (!parsed.success) throw new ProviderError("invalid_request");
    this.plan = parsed.data;
  }
  async chat(_r: ModelRequest, _s: AbortSignal): Promise<ModelReply> {
    throw new ProviderError("unsupported_mode");
  }
  async vision(_r: ModelRequest, _s: AbortSignal): Promise<ModelReply> {
    throw new ProviderError("unsupported_mode");
  }
  async structured(r: ModelRequest, s: AbortSignal): Promise<ModelReply> {
    return this.reply("structured", r, s);
  }
  async tools(r: ModelRequest, s: AbortSignal): Promise<ModelReply> {
    return this.reply("tools", r, s);
  }
  private reply(
    mode: "structured" | "tools",
    r: ModelRequest,
    s: AbortSignal,
  ): Promise<ModelReply> {
    const envelope = JSON.parse(r.messages.at(-1)!.content) as {
      trustedRuntime: { plannedStep: EditPlanV1["steps"][number] | null };
    };
    const proposed = envelope.trustedRuntime.plannedStep;
    const step = mode === "tools" ? this.plan.steps.find((t) => t.id === proposed?.id) : null;
    if (mode === "tools" && (!step || contentHash(step) !== contentHash(proposed)))
      throw new ProviderError("invalid_request");
    return new ReplayProvider(this.capabilities, [
      {
        mode,
        requestSha256: requestHash(mode, r),
        reply: {
          text: null,
          structured: mode === "structured" ? this.plan : null,
          calls: step
            ? [
                {
                  idSha256: contentHash({ fixtureStep: step.id }),
                  name: protocolToolName(step.tool),
                  arguments: stepInput(step),
                },
              ]
            : [],
        },
        syntheticUsage: { inputTokens: 17, outputTokens: 23 },
      },
    ])[mode](r, s);
  }
}
