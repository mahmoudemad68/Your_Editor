"use client";

import { useEffect, useState } from "react";
import type { ApiResult, ProjectApi, ProjectRecord } from "../project-contract";
import { productLabel } from "./product-label";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; projects: readonly ProjectRecord[] }
  | { status: "unauthorized" }
  | { status: "error"; message: string };

export function Dashboard({ api }: { api: ProjectApi }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ProjectRecord | null>(null);

  async function load(): Promise<void> {
    setState({ status: "loading" });
    const result = await api.listProjects();
    setState(fromList(result));
  }

  useEffect(() => {
    void load();
  }, [api]);

  return (
    <main className="px-4 py-6 md:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
        <div>
          <p className="text-sm text-muted">{productLabel()}</p>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        </div>
        <Button
          variant="primary"
          onClick={() => setCreating(true)}
          disabled={state.status === "loading" || state.status === "unauthorized"}
        >
          Create project
        </Button>
      </header>
      <section className="mt-6" aria-live="polite">
        {state.status === "loading" ? <p aria-busy="true">Loading projects…</p> : null}
        {state.status === "unauthorized" ? (
          <StatusPanel
            title="Sign-in is required"
            body="This dashboard does not sign you in. Production authentication arrives in a later release. Until then, the Project service answers 401."
            actionLabel="Try again"
            onAction={() => void load()}
          />
        ) : null}
        {state.status === "error" ? (
          <StatusPanel
            title="Projects could not be loaded"
            body={state.message}
            actionLabel="Retry"
            onAction={() => void load()}
          />
        ) : null}
        {state.status === "ready" && state.projects.length === 0 ? (
          <StatusPanel
            title="No projects yet"
            body="Create a project to give an edit its own workspace."
            actionLabel="Create project"
            onAction={() => setCreating(true)}
          />
        ) : null}
        {state.status === "ready" && state.projects.length > 0 ? (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {state.projects.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} onDelete={() => setDeleting(project)} />
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <CreateProjectDialog
        open={creating}
        api={api}
        onOpenChange={setCreating}
        onCreated={(project) => {
          setState((current) => {
            if (current.status !== "ready") {
              return { status: "ready", projects: [project] };
            }
            return { status: "ready", projects: [...current.projects, project] };
          });
        }}
      />
      <DeleteProjectDialog
        project={deleting}
        api={api}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
          }
        }}
        onDeleted={(projectId) => {
          setDeleting(null);
          setState((current) => {
            if (current.status !== "ready") {
              return current;
            }
            return {
              status: "ready",
              projects: current.projects.filter((project) => project.id !== projectId),
            };
          });
        }}
      />
    </main>
  );
}

function fromList(result: ApiResult<readonly ProjectRecord[]>): LoadState {
  if (result.ok) {
    return { status: "ready", projects: result.data };
  }
  if (result.status === 401) {
    return { status: "unauthorized" };
  }
  return { status: "error", message: result.message };
}

function ProjectCard({ project, onDelete }: { project: ProjectRecord; onDelete: () => void }) {
  return (
    <article className="flex h-full flex-col rounded-lg border border-line bg-panel p-4">
      <h2 className="text-lg font-semibold">{project.name}</h2>
      <p className="mt-2 text-sm text-muted">
        Role <span className="text-paper">{roleLabel(project.role)}</span>
      </p>
      <p className="text-sm text-muted">Updated {formatInstant(project.updatedAt)}</p>
      <div className="mt-4 flex gap-2">
        <a
          className="inline-flex items-center rounded-md border border-line px-3 py-2 text-sm"
          href={`/projects/${project.id}`}
        >
          Open project
        </a>
        {project.role === "owner" ? (
          <Button variant="danger" onClick={onDelete}>
            Delete
          </Button>
        ) : null}
      </div>
    </article>
  );
}

function CreateProjectDialog({
  open,
  api,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  api: ProjectApi;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: ProjectRecord) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("A Project name is required.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await api.createProject(trimmed);
    setPending(false);
    if (!result.ok) {
      setError(result.status === 401 ? "Sign-in is required." : result.message);
      return;
    }
    setName("");
    onOpenChange(false);
    onCreated(result.data);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          setError(null);
          onOpenChange(next);
        }
      }}
      title="Create project"
      description="The name is stored after the Project service accepts it."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block text-sm" htmlFor="project-name">
          Project name
        </label>
        <input
          id="project-name"
          className="mt-2 w-full rounded-md border border-line bg-ink px-3 py-2"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
        {error ? (
          <p className="mt-2 text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? "Creating…" : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteProjectDialog({
  project,
  api,
  onOpenChange,
  onDeleted,
}: {
  project: ProjectRecord | null;
  api: ProjectApi;
  onOpenChange: (open: boolean) => void;
  onDeleted: (projectId: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function confirm(): Promise<void> {
    if (project === null) {
      return;
    }
    setPending(true);
    setError(null);
    const result = await api.deleteProject(project.id);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onDeleted(project.id);
  }

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(open) => {
        if (!pending) {
          setError(null);
          onOpenChange(open);
        }
      }}
      title="Delete project"
      description={
        project === null
          ? undefined
          : `Delete ${project.name}. The Project service confirms the removal.`
      }
    >
      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button type="button" variant="danger" disabled={pending} onClick={() => void confirm()}>
          {pending ? "Deleting…" : "Delete project"}
        </Button>
      </div>
    </Dialog>
  );
}

function StatusPanel({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-lg border border-dashed border-line p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-xl text-sm text-muted">{body}</p>
      <Button className="mt-4" variant="secondary" onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}

function roleLabel(role: ProjectRecord["role"]): string {
  if (role === "owner") {
    return "Owner";
  }
  if (role === "editor") {
    return "Editor";
  }
  return "Viewer";
}

function formatInstant(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}
