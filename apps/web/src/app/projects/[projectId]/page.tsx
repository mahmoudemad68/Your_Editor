"use client";

import { useParams } from "next/navigation";
import { hashFileInWorker } from "../../upload-hash";
import { browserProjectApi } from "../../../presentation/browser-project-api";
import { ProjectScreen } from "../../../presentation/project-screen";
import { AppShell } from "../../../presentation/shell";

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  return (
    <AppShell currentPath={`/projects/${projectId}`}>
      <ProjectScreen projectId={projectId} api={browserProjectApi} hashFile={hashFileInWorker} />
    </AppShell>
  );
}
