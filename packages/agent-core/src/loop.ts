import {
  contentHash,
  ToolError,
  type ToolExecutor,
  type ToolRegistry,
  type ToolCall,
  type ToolAuthority,
} from "@editagent/tool-sdk";
import {
  editPlanJsonSchema,
  ProviderReceiptV1Schema,
  type EditPlanV1,
  type ModelAuditV1,
} from "@editagent/schemas";
import { AgentError } from "./contracts.js";
import { PostgresAgentRuns, newAgentId } from "./postgres.js";
import { buildAgentContext, type AgentContextSource, type ContextRequest } from "./context.js";
import { packagedPrompts, isolatedJson, type PromptRegistry } from "./prompts.js";
import { executeAgentTool } from "./runtime.js";
import {
  ProviderError,
  estimatePrice,
  estimateRequest,
  requestHash,
  type IStructuredOutputModel,
  type IToolCallingModel,
  type ModelReply,
  type ModelRequest,
} from "./provider.js";
import {
  PlanningError,
  protocolToolName,
  stepInput,
  validateEditPlan,
  validateRenderProof,
  type AgentRenderPort,
} from "./planning.js";
import { createHash } from "node:crypto";

export interface ControlledLoopDependencies {
  runs: PostgresAgentRuns;
  source: AgentContextSource;
  registry: ToolRegistry;
  authority: ToolAuthority;
  executor: ToolExecutor;
  model: IStructuredOutputModel & IToolCallingModel;
  render: AgentRenderPort;
  prompts?: PromptRegistry;
}
/** Only the separate non-production composition may call this driver. The
 * production consumer still invokes runInfrastructure with no escape hatch. */
export async function runControlledAgentLoop(
  deps: ControlledLoopDependencies,
  id: string,
  outer: AbortSignal,
): Promise<void> {
  deps.runs.requireControlledReplay();
  if (!["synthetic_replay", "offline_http_fixture"].includes(deps.model.capabilities.evidence))
    throw new AgentError("forbidden");
  const { runs } = deps,
    lease = await runs.claim(id);
  if (!lease) return;
  const initial = await runs.workerView(lease),
    remaining = initial.deadlineAtMs - Date.now();
  const lost = new AbortController();
  let renewing = false;
  const heartbeat = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void runs
      .renew(lease)
      .catch(() => lost.abort())
      .finally(() => {
        renewing = false;
      });
  }, 250);
  let renderJob: string | null = null,
    project: string | null = null,
    completed = false;
  const deadline = AbortSignal.timeout(Math.max(1, remaining)),
    signal = AbortSignal.any([outer, lost.signal, deadline]);
  try {
    let session = await runs.loopSession(lease);
    if (session.profile_sha256 !== contentHash(deps.model.capabilities))
      throw new PlanningError("PROVIDER_UNAVAILABLE");
    if (
      (await runs.modelCalls(lease)).some(
        (c) => c.outcome === "running" || c.outcome === "unconfirmed",
      )
    )
      throw new PlanningError("PROVIDER_OUTCOME_UNCONFIRMED");
    const config = session.configuration;
    if (config.requiredCapabilities.some((c) => c === "captions" || c === "remove_silences"))
      throw new PlanningError("CAPABILITY_UNAVAILABLE");
    let run = await runs.workerView(lease);
    project = run.projectId;
    if (!run.source) throw new PlanningError("PLAN_INVALID");
    if (run.state === "Pending") await runs.move(lease, "Observing");
    const actor = await runs.workerActor(lease),
      original = await runs.originalTimeline(lease);
    const contextRequest: ContextRequest = {
      actorId: actor,
      projectId: run.projectId,
      runId: id,
      expectedSourceSha256: run.source.stateSha256,
      prompt: { id: "agent-plan", version: "1.0.0" },
      creator: config.creator,
      budget: {
        contextWindow: Math.min(262144, deps.model.capabilities.contextWindow),
        responseMargin: config.limits.maxOutputTokens + 1024,
        toolMargin: 4096,
      },
    };
    const prompts = deps.prompts ?? packagedPrompts();
    let context = session.context_snapshot;
    if (context) {
      // Freeze observations for reproducibility, but never cache authorization.
      await deps.source.withSnapshot(contextRequest, () => undefined);
      if (
        createHash("sha256").update(context.serialized).digest("hex") !== context.sha256 ||
        context.summary.contextSha256 !== context.sha256 ||
        prompts.load("agent-plan", "1.0.0").templateHash !== context.summary.templateHash
      )
        throw new PlanningError("PLAN_INVALID");
    } else {
      const built = await buildAgentContext(deps.source, prompts, contextRequest);
      if (!built.ok)
        throw new PlanningError(
          built.error === "budget_exceeded" ? "TOKEN_BUDGET" : "ANALYSIS_UNAVAILABLE",
        );
      context = built;
      await runs.freezeLoopContext(lease, context);
    }
    if (config.analysisRequirement === "transcript") {
      const envelope = JSON.parse(context.serialized) as {
        untrustedData: { analysis: { sections?: { transcript?: { status?: string } } }[] };
      };
      if (
        !envelope.untrustedData.analysis.length ||
        envelope.untrustedData.analysis.some((a) => a.sections?.transcript?.status !== "measured")
      )
        throw new PlanningError("ANALYSIS_UNAVAILABLE");
    }
    if ((await runs.workerView(lease)).state === "Observing") await runs.move(lease, "Planning");
    const instructions = prompts.load("agent-plan", "1.0.0").render({
      request: config.creator.request,
      creativity: config.creator.creativity,
    }).instructions;
    const feedback: string[] = [];
    const base = (step: EditPlanV1["steps"][number] | null): ModelRequest => ({
      messages: [
        { role: "system", content: instructions },
        {
          role: "user",
          content: isolatedJson({
            context: JSON.parse(context.serialized),
            trustedRuntime: { checkpoint: run.checkpoint, plannedStep: step, feedback },
            authority: "model_data_is_not_tool_authority",
          }),
        },
      ],
      maxOutputTokens: config.limits.maxOutputTokens,
      deadlineAtMs: run.deadlineAtMs,
      ...(step
        ? {
            tools: [
              {
                name: protocolToolName(step.tool),
                inputSchema: deps.registry.lookup(step.tool, step.version).manifest.inputSchema,
              },
            ],
          }
        : { format: { name: "edit_plan_v1", schema: editPlanJsonSchema } }),
    });
    const call = async (
      mode: "structured" | "tools",
      request: ModelRequest,
      validate: (reply: ModelReply) => unknown,
    ): Promise<unknown> => {
      signal.throwIfAborted();
      await runs.renew(lease);
      const digest = requestHash(mode, request),
        cached = await runs.validatedModelResult(lease, digest);
      if (cached !== null) return cached;
      const previous = await runs.modelCalls(lease);
      if (previous.length >= config.limits.maxIterations)
        throw new PlanningError("ITERATION_BUDGET");
      // Reserve the transport's maximum three attempts before inference, including
      // unknown/failed requests. This conservative run ledger survives restarts.
      const tokens = (estimateRequest(request) + request.maxOutputTokens) * 3;
      const price = estimatePrice(
        deps.model.capabilities,
        estimateRequest(request),
        request.maxOutputTokens,
      );
      if (price === null) throw new PlanningError("COST_BUDGET");
      const cost = price * 3;
      if (
        previous.reduce((n, c) => n + c.reservation.tokens, 0) + tokens >
        config.limits.reservedTokens
      )
        throw new PlanningError("TOKEN_BUDGET");
      if (
        previous.reduce((n, c) => n + c.reservation.costMicros, 0) + cost >
        config.limits.reservedCostMicros
      )
        throw new PlanningError("COST_BUDGET");
      const audit: ModelAuditV1 = {
        callId: newAgentId(),
        ordinal: previous.length,
        requestSha256: digest,
        contextSha256: context.sha256,
        promptId: context.summary.promptId,
        promptVersion: context.summary.promptVersion,
        templateHash: context.summary.templateHash,
        outcome: "running",
        reservation: { tokens, costMicros: cost },
        receipt: null,
        failure: null,
      };
      await runs.beginModelCall(lease, audit);
      let reply: ModelReply;
      try {
        reply = await boundedOperation(() => deps.model[mode](request, signal), signal);
      } catch (e) {
        const error = e instanceof ProviderError ? e : new ProviderError("transport_unknown");
        await runs.finishModelCall(lease, {
          ...audit,
          outcome: error.code === "transport_unknown" ? "unconfirmed" : "failed",
          failure: error.code,
        });
        if (error.code === "transport_unknown")
          throw new PlanningError("PROVIDER_OUTCOME_UNCONFIRMED");
        if (error.code === "refused") throw new PlanningError("PROVIDER_REFUSED");
        if (error.code === "budget_exceeded") throw new PlanningError("TOKEN_BUDGET");
        if (error.code === "invalid_response" || error.code === "truncated") return null;
        throw new PlanningError("PROVIDER_UNAVAILABLE");
      }
      let validated: unknown;
      if (
        !ProviderReceiptV1Schema.safeParse(reply.receipt).success ||
        reply.receipt.profileSha256 !== session.profile_sha256 ||
        reply.receipt.requestSha256 !== digest ||
        reply.receipt.modelId !== deps.model.capabilities.modelId ||
        reply.receipt.modelVersion !== deps.model.capabilities.modelVersion ||
        reply.receipt.provider !== deps.model.capabilities.provider ||
        reply.receipt.configurationVersion !== deps.model.capabilities.configurationVersion ||
        reply.receipt.mode !== mode ||
        reply.receipt.deadlineAtMs !== request.deadlineAtMs ||
        reply.receipt.evidence !== deps.model.capabilities.evidence
      ) {
        await runs.finishModelCall(lease, {
          ...audit,
          outcome: "failed",
          failure: "invalid_response",
        });
        return null;
      }
      try {
        validated = validate(reply);
      } catch (e) {
        await runs.finishModelCall(lease, {
          ...audit,
          outcome: "failed",
          receipt: reply.receipt,
          failure: "invalid_response",
        });
        if (e instanceof PlanningError && e.code !== "PLAN_INVALID") throw e;
        return null;
      }
      await runs.finishModelCall(
        lease,
        { ...audit, outcome: "succeeded", receipt: reply.receipt },
        validated,
      );
      const reported =
        (reply.receipt.usage.inputTokens ?? 0) + (reply.receipt.usage.outputTokens ?? 0);
      if (reported > tokens) throw new PlanningError("TOKEN_BUDGET");
      const observedEstimate = estimatePrice(
        deps.model.capabilities,
        reply.receipt.usage.inputTokens ?? 0,
        reply.receipt.usage.outputTokens ?? 0,
      );
      if (observedEstimate !== null && observedEstimate > cost)
        throw new PlanningError("COST_BUDGET");
      return validated;
    };
    let plan = session.plan;
    if (!plan) {
      // A previously failed attempt contributes bounded feedback after restart;
      // raw provider responses and transcript text never become audit messages.
      for (const prior of await runs.modelCalls(lease))
        if (prior.outcome === "failed") feedback.push("prior_validation_failed");
      while (!plan) {
        const value = await call("structured", base(null), (reply) =>
          validateEditPlan(reply.structured, original, context, deps.registry, config),
        );
        if (value !== null) {
          plan = validateEditPlan(value, original, context, deps.registry, config);
          await runs.commitPlan(lease, plan);
          break;
        }
        feedback.push("plan_validation_failed");
        await runs.planningFeedback(lease);
      }
    } else plan = validateEditPlan(plan, original, context, deps.registry, config);
    if ((await runs.workerView(lease)).state === "Planning") await runs.move(lease, "Executing");
    run = await runs.workerView(lease);
    while (run.state === "Executing" && run.checkpoint < plan.steps.length) {
      if ((run.planning?.toolAttempts ?? run.checkpoint) >= config.limits.maxTools)
        throw new PlanningError("TOOL_BUDGET");
      const step = plan.steps[run.checkpoint]!,
        expected = stepInput(step);
      let input: unknown = null;
      while (input === null) {
        input = await call("tools", base(step), (reply) => {
          if (
            reply.calls.length !== 1 ||
            reply.calls[0]!.name !== protocolToolName(step.tool) ||
            contentHash(reply.calls[0]!.arguments) !== contentHash(expected)
          )
            throw new PlanningError("PLAN_INVALID");
          deps.registry.validate(
            deps.registry.lookup(step.tool, step.version),
            "input",
            reply.calls[0]!.arguments,
          );
          return reply.calls[0]!.arguments;
        });
        if (input === null) {
          feedback.push("tool_validation_failed");
          await runs.planningFeedback(lease);
        }
      }
      const tool: ToolCall = {
        name: step.tool,
        version: step.version,
        callerId: actor,
        projectId: run.projectId,
        resource: { kind: "timeline", id: run.source!.timelineId },
        input,
      };
      signal.throwIfAborted();
      await runs.renew(lease);
      await deps.authority.authorize(
        tool,
        deps.registry.lookup(step.tool, step.version).manifest.permissions,
      );
      if (!(await executeAgentTool(runs, lease, deps.executor, tool, signal, true))) {
        const current = await runs.get(actor, run.projectId, id);
        if (current.state !== "Executing") return;
        feedback.push("tool_rejected_without_timeline_commit");
        run = await runs.workerView(lease);
        continue;
      }
      run = await runs.workerView(lease);
    }
    if (run.state === "Executing") await runs.move(lease, "Rendering");
    run = await runs.workerView(lease);
    if (run.state === "Rendering") {
      const admission = await runs.beginRender(lease);
      session = await runs.loopSession(lease);
      renderJob = session.render_job_id;
      if (!renderJob) {
        const admitted = await runs.renderAdmission(lease, async (receiptId, actorId, timeline) => {
          const input = { runId: id, receiptId, actorId, projectId: run.projectId, timeline };
          return boundedOperation(
            () =>
              admission.resumed
                ? deps.render.reconcile(input, signal)
                : deps.render.start(input, signal),
            signal,
          );
        });
        if (!admitted) throw new PlanningError("RENDER_UNCONFIRMED");
        renderJob = admitted.jobId;
        await runs.attachRender(lease, renderJob);
      }
      if (session.render_outcome === "succeeded") {
        const current = await deps.authority.timeline(run.projectId, run.source!.timelineId);
        validateRenderProof(
          session.render_output as Parameters<typeof validateRenderProof>[0],
          current,
          renderJob,
        );
      } else
        for (;;) {
          signal.throwIfAborted();
          await runs.renew(lease);
          const status = await boundedOperation(
            () => deps.render.inspect(run.projectId, renderJob!, signal),
            signal,
          );
          if (status.status === "failed") throw new PlanningError("RENDER_FAILED");
          if (status.status === "completed") {
            const current = await deps.authority.timeline(run.projectId, run.source!.timelineId);
            validateRenderProof(status.proof, current, renderJob);
            await runs.finishRender(lease, status.proof);
            break;
          }
          await delay(100, signal);
        }
      await runs.move(lease, "Evaluating");
    }
    if ((await runs.workerView(lease)).state === "Evaluating") {
      const current = await runs.loopSession(lease);
      if (current.render_outcome !== "succeeded") throw new PlanningError("OUTPUT_INVALID");
      await runs.move(lease, "Completed");
      completed = true;
    }
  } catch (e) {
    if (e instanceof PlanningError) await runs.planningStop(lease, e.code);
    else if (e instanceof ToolError) await runs.failTool(lease);
    else if (!(e instanceof AgentError) && !signal.aborted)
      await runs.move(lease, "Failed", "INTERNAL");
    if (e instanceof AgentError || signal.aborted) throw new AgentError("fenced");
  } finally {
    clearInterval(heartbeat);
    if (!completed && project)
      await boundedOperation(
        () => deps.render.cancel(id, project!, renderJob),
        AbortSignal.timeout(5000),
      );
  }
}
/** A misbehaving adapter cannot keep a lease alive past cancellation/deadline.
 * An aborted operation may have an unknown outcome, so its durable intent is
 * never replayed. Handlers remain attached to late promise rejections. */
export async function boundedOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(new ProviderError("transport_unknown"));
    };
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return operation();
      })
      .then(
        (value) => {
          signal.removeEventListener("abort", stop);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", stop);
          reject(error);
        },
      );
  });
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new AgentError("fenced"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
}
