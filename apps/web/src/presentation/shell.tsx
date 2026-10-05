"use client";

import { Menu, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ProtectedSession, useSession } from "./session-view";
import { sessionClient } from "./session-client";
import { productLabel } from "./product-label";
import { Button } from "./ui/button";

export function AppShell({
  children,
  currentPath = "/",
}: {
  children: ReactNode;
  currentPath?: string;
}) {
  const session = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const onProjects = currentPath === "/";
  return (
    <ProtectedSession>
      <div className="min-h-screen bg-ink text-paper">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              className="md:hidden"
              aria-expanded={navOpen}
              aria-controls="app-nav"
              onClick={() => setNavOpen((open) => !open)}
            >
              {navOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
              <span className="sr-only">{navOpen ? "Close navigation" : "Open navigation"}</span>
            </Button>
            <span className="font-semibold tracking-tight">{productLabel()}</span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            {session.status === "authenticated" ? (
              <span className="text-sm text-muted">{session.user.email}</span>
            ) : null}
            <Button
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                setSignOutError(null);
                void sessionClient.logout().then((error) => {
                  setSigningOut(false);
                  if (error) setSignOutError(error);
                  else window.location.replace("/sign-in");
                });
              }}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </Button>
            {signOutError ? (
              <p role="alert" className="text-sm text-danger">
                {signOutError}
              </p>
            ) : null}
          </div>
        </header>
        <div className="min-w-0 md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
          <aside
            id="app-nav"
            className={`${navOpen ? "block" : "hidden"} border-line bg-panel md:block md:border-r`}
          >
            <nav className="px-3 py-4" aria-label="Application">
              <a
                href="/"
                {...(onProjects ? { "aria-current": "page" as const } : {})}
                className="block rounded-md bg-panel-raised px-3 py-2 text-sm font-medium text-paper"
              >
                Projects
              </a>
            </nav>
          </aside>
          <div className="min-w-0">{children}</div>
        </div>
      </div>
    </ProtectedSession>
  );
}
