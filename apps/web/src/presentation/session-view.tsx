"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { sessionClient } from "./session-client";
import { safeReturnTo } from "./auth-validation";
import { Button } from "./ui/button";

export function useSession() {
  return useSyncExternalStore(
    sessionClient.subscribe,
    sessionClient.getSnapshot,
    sessionClient.getServerSnapshot,
  );
}

export function ProtectedSession({ children }: { children: ReactNode }) {
  const session = useSession();
  useEffect(() => {
    void sessionClient.bootstrap();
  }, []);
  useEffect(() => {
    if (session.status === "unauthenticated") {
      const target = safeReturnTo(
        `${window.location.pathname}${window.location.search}${window.location.hash}`,
      );
      window.location.replace(`/sign-in?returnTo=${encodeURIComponent(target)}`);
    }
  }, [session.status]);
  if (session.status === "authenticated") return children;
  return (
    <main className="min-h-screen bg-ink p-8 text-paper" aria-live="polite">
      {session.status === "error" ? (
        <>
          <p role="alert">{session.message}</p>
          <Button onClick={() => void sessionClient.bootstrap()}>Retry</Button>
        </>
      ) : (
        <p role="status">Checking your session…</p>
      )}
    </main>
  );
}
