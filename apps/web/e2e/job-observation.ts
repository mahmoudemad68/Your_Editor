import type { Page } from "@playwright/test";
/** Test-only network/DOM timestamps, observing the same browser connection. */
export async function observeJobs(page: Page) {
  await page.addInitScript(() => {
    const trace = {
      opens: [] as Array<{ project: string; at: number; closedAt?: number }>,
      events: [] as Array<{ project: string; event: { projectId: string }; at: number }>,
      snapshots: [] as Array<{ job: { status: string } | null; at: number }>,
      domProgress: {} as Record<string, number>,
      domCompletedAt: 0,
    };
    (window as typeof window & { jobTrace: typeof trace }).jobTrace = trace;
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      const url = String(input);
      if (url.endsWith("/inspection-job") && response.ok) {
        void response
          .clone()
          .json()
          .then((snapshot) => trace.snapshots.push({ ...snapshot, at: Date.now() }));
      }
      if (url.endsWith("/jobs/events") && response.ok && response.body) {
        const project = url.split("/").at(-3)!;
        const connection = { project, at: Date.now(), closedAt: undefined as number | undefined };
        trace.opens.push(connection);
        void (async () => {
          const reader = response.clone().body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              buffer += decoder.decode(chunk.value, { stream: true });
              let end;
              while ((end = buffer.indexOf("\n\n")) >= 0) {
                const frame = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                const data = frame.split("\n").find((line) => line.startsWith("data: "));
                if (data)
                  trace.events.push({ project, event: JSON.parse(data.slice(6)), at: Date.now() });
              }
            }
          } catch {
            /* Transport reset is an expected observation. */
          } finally {
            connection.closedAt = Date.now();
            await reader.cancel().catch(() => {});
          }
        })();
      }
      return response;
    };
    const observer = new MutationObserver(() => {
      const panel = document.querySelector('[aria-label="Inspection job"]');
      const job = panel?.getAttribute("data-job-id");
      if (job && panel?.textContent?.includes("Preparing · 0%") && !trace.domProgress[job])
        trace.domProgress[job] = Date.now();
      if (panel?.textContent?.includes("Completed") && !trace.domCompletedAt)
        trace.domCompletedAt = Date.now();
    });
    observer.observe(document, { childList: true, subtree: true, characterData: true });
  });
}
export function readJobTrace(page: Page) {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          jobTrace: {
            opens: Array<{ project: string; at: number; closedAt?: number }>;
            events: Array<{ project: string; event: { projectId: string }; at: number }>;
            snapshots: Array<{ job: { status: string } | null; at: number }>;
            domProgress: Record<string, number>;
            domCompletedAt: number;
          };
        }
      ).jobTrace,
  );
}
