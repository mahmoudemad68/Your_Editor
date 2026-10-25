import { applyCommand, parseCommand, Timeline } from "@editagent/domain";
import { contentHash } from "@editagent/tool-sdk";
import { AgentError, type AgentExport } from "./contracts.js";

/** Offline command replay, never a tool invocation or publication API. The
 * operator supplies an authorized immutable original snapshot matching the hash.
 * Every intermediate hash must match the atomic ledger receipt. */
export function replayAgentCommands(original: unknown, pages: readonly AgentExport[]): Timeline {
  if (pages.length === 0 || pages.length > 256) throw new AgentError("invalid_input");
  let timeline = Timeline.restore(original);
  const first = pages[0]!,
    source = first.run.source;
  if (
    !source ||
    source.timelineId !== timeline.id ||
    first.run.projectId !== timeline.projectId ||
    contentHash(original) !== source.stateSha256
  )
    throw new AgentError("conflict");
  let sequence = 0;
  const receipts = new Set<string>();
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    if (
      page.run.id !== first.run.id ||
      page.schemaVersion !== "1.0.0" ||
      page.throughSequence !== first.throughSequence ||
      page.events.length > 100 ||
      page.replay.effects !== "never_reexecute_tools" ||
      contentHash(page.run.source) !== contentHash(source) ||
      (index === pages.length - 1) !== (page.nextCursor === null)
    )
      throw new AgentError("invalid_input");
    for (const event of page.events) {
      if (event.sequence !== ++sequence || event.runId !== first.run.id)
        throw new AgentError("invalid_input");
    }
    const succeeded = new Set(
      page.events
        .filter((e) => e.kind === "tool_result" && e.tool?.outcome === "succeeded")
        .map((e) => e.tool!.receiptId),
    );
    if (succeeded.size !== page.replay.commands.length) throw new AgentError("invalid_input");
    for (const receipt of page.replay.commands) {
      if (
        !succeeded.has(receipt.receiptId) ||
        receipts.has(receipt.receiptId) ||
        receipt.basisSha256 !== contentHash(timeline.toSnapshot()) ||
        receipt.commands.length !== 1
      )
        throw new AgentError("conflict");
      for (const raw of receipt.commands) {
        const command = parseCommand(raw);
        if (command.id !== receipt.receiptId || !["TrimClip", "SplitClip"].includes(command.type))
          throw new AgentError("invalid_input");
        timeline = applyCommand(timeline, command).timeline;
      }
      if (contentHash(timeline.toSnapshot()) !== receipt.resultSha256)
        throw new AgentError("conflict");
      receipts.add(receipt.receiptId);
    }
  }
  if (sequence !== first.throughSequence) throw new AgentError("invalid_input");
  return timeline;
}
