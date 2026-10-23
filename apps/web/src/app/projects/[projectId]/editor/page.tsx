import { AppShell } from "../../../../presentation/shell";
import { ManualEditor } from "../../../../presentation/manual-editor";
export default async function EditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ media?: string; timeline?: string }>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  return (
    <AppShell currentPath={`/projects/${projectId}`}>
      <ManualEditor
        projectId={projectId}
        {...(typeof query.media === "string" ? { mediaId: query.media } : {})}
        {...(typeof query.timeline === "string" ? { initialTimelineId: query.timeline } : {})}
      />
    </AppShell>
  );
}
