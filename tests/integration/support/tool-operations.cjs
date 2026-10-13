/** Fixed, non-sensitive integration worker. Never registered in a production service. */
exports.echo = async (input, _context, progress) => {
  progress(10);
  progress(50);
  return { output: { text: input.text }, costMicros: 1 };
};
exports.busy = async (_input, _context, progress) => {
  progress(10);
  // Deliberately ignores cancellation; Worker.terminate must stop owned JS.
  for (;;) {
    /* non-cooperative CPU work */
  }
};
