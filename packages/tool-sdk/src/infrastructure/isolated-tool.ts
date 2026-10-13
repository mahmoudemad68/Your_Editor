import { Worker } from "node:worker_threads";
import path from "node:path";
import { type ITool, type OwnedToolRun, type ToolContext, type ToolResult } from "../registry.js";
import { ToolError, jsonValue } from "../validation.js";
/** Fixed deployment registration, never from a manifest/job payload. Threads are cleanup isolation, NOT an untrusted-code sandbox. */
export class IsolatedTool implements ITool {
  private readonly workers = new Set<Worker>();
  get activeWorkerCount(): number {
    return this.workers.size;
  }
  constructor(
    private readonly modulePath: string,
    private readonly exportName: string,
  ) {
    if (!path.isAbsolute(modulePath) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(exportName))
      throw new ToolError("invalid_binding");
  }
  start(input: unknown, context: ToolContext): OwnedToolRun {
    const worker = new Worker(path.join(__dirname, "tool-thread.js"), {
      workerData: {
        modulePath: this.modulePath,
        exportName: this.exportName,
        input: jsonValue(input),
        context: {
          executionId: context.executionId,
          callerId: context.callerId,
          projectId: context.projectId,
          resource: context.resource,
        },
      },
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    });
    this.workers.add(worker);
    worker.once("exit", () => this.workers.delete(worker));
    let settled = false;
    let stop: Promise<void> | undefined;
    const cancel = () => (stop ??= worker.terminate().then(() => undefined));
    const result = new Promise<ToolResult>((resolve, reject) => {
      worker.on("message", (m: unknown) => {
        try {
          const data = jsonValue(m) as Record<string, unknown>;
          if (data.kind === "progress") {
            void context.progress(data.percentage as number).catch(() => {
              void cancel();
            });
            return;
          }
          if (data.kind !== "result" || settled) throw new ToolError("invalid_worker_result");
          settled = true;
          resolve(data.result as ToolResult);
        } catch {
          reject(new ToolError("invalid_worker_result"));
          void cancel();
        }
      });
      worker.once("error", () => reject(new ToolError("worker_failed")));
      worker.once("exit", () => {
        if (!settled) reject(new ToolError("worker_stopped"));
      });
    }).finally(async () => {
      context.signal.removeEventListener("abort", abort);
      await cancel();
    });
    const abort = () => {
      void cancel();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted) abort();
    return {
      result,
      cancel,
      forceStop: async () => {
        await worker.terminate();
      },
    };
  }
}
