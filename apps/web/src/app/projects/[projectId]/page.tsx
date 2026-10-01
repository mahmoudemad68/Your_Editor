"use client";

import { useParams } from "next/navigation";
import { browserProjectApi } from "../../../presentation/browser-project-api";
import { ProjectScreen } from "../../../presentation/project-screen";
import { AppShell } from "../../../presentation/shell";

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  return (
    <AppShell>
      <ProjectScreen projectId={projectId} api={browserProjectApi} />
    </AppShell>
  );
}
