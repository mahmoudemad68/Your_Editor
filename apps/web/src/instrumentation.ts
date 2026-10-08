export async function register(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return;
  }
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { loadWebConfig } = await import("./infrastructure/config");
  loadWebConfig();
  const { startNoopTracing } = await import("@editagent/shared");
  startNoopTracing("web");
  const { jobStreamRegistry } = await import("./infrastructure/job-stream-lifecycle");
  jobStreamRegistry.install();
}
