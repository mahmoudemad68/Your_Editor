"use client";

import { browserProjectApi } from "../presentation/browser-project-api";
import { Dashboard } from "../presentation/dashboard";
import { AppShell } from "../presentation/shell";

export default function HomePage() {
  return (
    <AppShell currentPath="/">
      <Dashboard api={browserProjectApi} />
    </AppShell>
  );
}
