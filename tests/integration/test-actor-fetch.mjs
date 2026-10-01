/**
 * Test-only fetch wrapper. The web application does not import this module.
 * It binds the API test actor so a dashboard test can call the production controllers.
 * US-118 replaces it with a verified session. It is not a sign-in system.
 */
export function fetchWithTestActor(actorUserId, baseFetch = fetch) {
  return (input, init) => {
    if (input instanceof Request) {
      const headers = new Headers(input.headers);
      headers.set("x-test-actor", actorUserId);
      return baseFetch(new Request(input, { headers }), init);
    }
    const headers = new Headers(init?.headers);
    headers.set("x-test-actor", actorUserId);
    return baseFetch(input, { ...init, headers });
  };
}
