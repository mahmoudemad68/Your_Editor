import { parentPort, workerData } from "node:worker_threads";
import { type ToolResult } from "../registry.js";
// Both module identity and export are supplied only by the trusted IsolatedTool registration.
async function main(): Promise<void> {
  const module = await import(workerData.modulePath as string);
  const execute = module[workerData.exportName] as (
    input: unknown,
    context: unknown,
    progress: (percentage: number) => void,
  ) => Promise<ToolResult>;
  if (typeof execute !== "function") throw new Error("Missing fixed implementation");
  const result = await execute(workerData.input, workerData.context, (percentage) =>
    parentPort?.postMessage({ kind: "progress", percentage }),
  );
  parentPort?.postMessage({ kind: "result", result });
}
if (parentPort) void main().catch(() => process.exit(1));
