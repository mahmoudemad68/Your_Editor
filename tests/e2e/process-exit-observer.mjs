// Test-only observation; no signal interception or exit/lifecycle replacement.
process.once("exit", () => {
  console.log(
    "WEB_EXIT_OBSERVATION",
    JSON.stringify({
      sigtermListeners: process.listenerCount("SIGTERM"),
      sigintListeners: process.listenerCount("SIGINT"),
      activeStreams: globalThis[Symbol.for("editagent.web.job-stream-registry")]?.count,
    }),
  );
});
