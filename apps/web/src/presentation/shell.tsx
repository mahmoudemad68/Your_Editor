"use client";

import { Menu, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { productLabel } from "./product-label";
import { Button } from "./ui/button";

export function AppShell({ children }: { children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  return (
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
        <p className="text-xs text-muted">Sign-in arrives with authentication</p>
      </header>
      <div className="md:grid md:grid-cols-[16rem_1fr]">
        <aside
          id="app-nav"
          className={`${navOpen ? "block" : "hidden"} border-line bg-panel md:block md:border-r`}
        >
          <nav className="px-3 py-4" aria-label="Application">
            <a
              href="/"
              aria-current="page"
              className="block rounded-md bg-panel-raised px-3 py-2 text-sm font-medium text-paper"
            >
              Projects
            </a>
          </nav>
          <p className="px-5 pb-6 text-xs leading-5 text-muted">
            Production sign-in is not part of this release. It arrives with authentication.
          </p>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
