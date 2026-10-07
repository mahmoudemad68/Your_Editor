/** Test-only real TCP interruption of just the API subscriber. Redis/BullMQ and
 * production workers remain available, allowing durable work during the gap. */
import { createServer, connect } from "node:net";
export async function createRedisTransportProxy(redisUrl) {
  const upstream = new URL(redisUrl);
  const sockets = new Set();
  let blocked = false;
  let lostAt = null;
  const server = createServer((incoming) => {
    if (blocked) {
      incoming.destroy();
      return;
    }
    const outgoing = connect(Number(upstream.port || 6379), upstream.hostname);
    for (const socket of [incoming, outgoing]) {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => {
        sockets.delete(socket);
        incoming.destroy();
        outgoing.destroy();
      });
    }
    incoming.pipe(outgoing).pipe(incoming);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = new URL(redisUrl);
  url.hostname = "127.0.0.1";
  url.port = String(address.port);
  return {
    url: url.toString(),
    break() {
      blocked = true;
      lostAt = Date.now();
      for (const socket of sockets) socket.destroy();
      return lostAt;
    },
    restore() {
      blocked = false;
    },
    state() {
      return { blocked, lostAt, sockets: sockets.size };
    },
    async close() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
