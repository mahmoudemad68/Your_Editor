import { type ToolManifest, type ITool, type ToolResult } from "./registry.js";
import {
  type ToolAuditRepository,
  type ExecutionRecord,
  type ExecutionOutcome,
  type ToolAuthority,
  type AuditSettlement,
} from "./executor.js";
import { ToolError } from "./validation.js";
export const ids = {
  owner: "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f",
  viewer: "018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f",
  project: "018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f",
  tool: "018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f",
  timeline: "018f6b6e-7c3a-7555-8d3e-9c0b1a2d3e4f",
  track: "018f6b6e-7c3a-7666-8d3e-9c0b1a2d3e4f",
  command: "018f6b6e-7c3a-7777-8d3e-9c0b1a2d3e4f",
  caption: "018f6b6e-7c3a-7888-8d3e-9c0b1a2d3e4f",
};
export const objectSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", minLength: 1, maxLength: 128 } },
};
export function manifest(change: Partial<ToolManifest> = {}): ToolManifest {
  return {
    schemaVersion: 1,
    id: ids.tool,
    name: "test.echo",
    version: "1.0.0",
    description: "A fixed test echo",
    inputSchema: objectSchema,
    outputSchema: objectSchema,
    permissions: ["project.read"],
    capabilities: ["audio"],
    estimatedCostMicros: 1,
    maximumCostMicros: 10,
    timeoutMs: 1000,
    mutating: false,
    validationRules: [],
    ...change,
  };
}
export function tool(execute: (input: unknown) => Promise<ToolResult> | ToolResult): ITool {
  return {
    start(input) {
      return {
        result: Promise.resolve().then(() => execute(input)),
        cancel: async () => undefined,
      };
    },
  };
}
export class MemoryAudit implements ToolAuditRepository {
  readonly rows = new Map<string, ExecutionRecord>();
  readonly reserved = new Map<string, number>();
  constructor(private readonly budget = 1000) {}
  async begin(r: ExecutionRecord): Promise<void> {
    this.rows.set(r.id, r);
  }
  async reserve(id: string, _project: string, cost: number): Promise<void> {
    if ([...this.reserved.values()].reduce((a, b) => a + b, 0) + cost > this.budget)
      throw new ToolError("budget_exceeded");
    this.reserved.set(id, cost);
    this.rows.set(id, { ...this.rows.get(id)!, costMicros: cost, costBasis: "reserved" });
  }
  async finish(
    id: string,
    outcome: Exclude<ExecutionOutcome, "running">,
    code: string | null,
    cost: number,
    settlement: AuditSettlement = {},
  ): Promise<ExecutionRecord> {
    const r = this.rows.get(id)!;
    if (r.outcome !== "running") return r;
    const next = {
      ...r,
      outcome,
      code,
      costMicros: cost,
      finishedAtMs: settlement.finishedAtMs ?? Date.now(),
      durationMs: (settlement.finishedAtMs ?? Date.now()) - r.startedAtMs,
      cleanupStatus:
        r.cleanupStatus === "failed" ? "failed" : (settlement.cleanupStatus ?? "not_required"),
      cleanupCode:
        r.cleanupStatus === "failed" || settlement.cleanupStatus === "failed"
          ? ("cleanup_unconfirmed" as const)
          : null,
      costBasis:
        settlement.costBasis ??
        (outcome === "succeeded" ? ("actual" as const) : ("reserved" as const)),
    };
    this.reserved.set(id, cost);
    this.rows.set(id, next);
    return next;
  }
  async noteCleanupFailure(id: string): Promise<void> {
    const r = this.rows.get(id)!;
    if (r.outcome === "running")
      this.rows.set(id, { ...r, cleanupStatus: "failed", cleanupCode: "cleanup_unconfirmed" });
  }
  async requestStop(id: string, code: "cancelled" | "timed_out"): Promise<void> {
    const r = this.rows.get(id)!;
    if (r.outcome === "running") this.rows.set(id, { ...r, stopCode: code });
  }
  async confirmCleanup(): Promise<void> {}
  async pendingRemote(): Promise<readonly ExecutionRecord[]> {
    return [];
  }
  async attachJob(id: string, jobId: string): Promise<void> {
    this.rows.set(id, { ...this.rows.get(id)!, jobId });
  }
  async get(id: string): Promise<ExecutionRecord | null> {
    return this.rows.get(id) ?? null;
  }
  async list(projectId: string, limit: number): Promise<readonly ExecutionRecord[]> {
    return [...this.rows.values()].filter((r) => r.projectId === projectId).slice(0, limit);
  }
}
export const authority: ToolAuthority = {
  authorize: async (c, p) => {
    if (
      c.callerId !== ids.owner ||
      c.projectId !== ids.project ||
      (c.resource.kind === "project" && c.resource.id !== ids.project) ||
      (p.includes("timeline.propose") && c.resource.kind !== "timeline")
    )
      throw new ToolError("denied");
  },
  timeline: async () => {
    throw new ToolError("missing_timeline");
  },
};
export const call = {
  name: "test.echo",
  version: "1.0.0",
  callerId: ids.owner,
  projectId: ids.project,
  resource: { kind: "project" as const, id: ids.project },
  input: { text: "hello" },
};
