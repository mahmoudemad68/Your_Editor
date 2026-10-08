"use client";

import { useCallback, useEffect, useState } from "react";
import type { ProjectApi, ProjectRecord } from "../project-contract";
import { MediaWorkspace } from "./media-upload";
import { MediaLibrary } from "./media-library";
import type { HashOptions } from "./sha256-file";
import type { SignedPutRequest, SignedPutResult } from "./signed-upload";
import { Button } from "./ui/button";

type ScreenState =
  | { status: "loading" }
  | { status: "unauthorized" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; project: ProjectRecord };

/** Project shell for a later upload page. It reuses the project list. There is no get-by-id route. */
export function ProjectScreen({
  projectId,
  api,
  hashFile,
  putObject,
}: {
  projectId: string;
  api: ProjectApi;
  hashFile?: (file: Blob, options?: HashOptions) => Promise<string>;
  putObject?: (request: SignedPutRequest) => Promise<SignedPutResult>;
}) {
  const [state, setState] = useState<ScreenState>({ status: "loading" });
  const [libraryRevision, setLibraryRevision] = useState(0);
  const uploaded = useCallback(() => setLibraryRevision((revision) => revision + 1), []);

  async function load(): Promise<void> {
    setState({ status: "loading" });
    const result = await api.listProjects();
    if (!result.ok) {
      setState(
        result.status === 401
          ? { status: "unauthorized" }
          : { status: "error", message: result.message },
      );
      return;
    }
    const project = result.data.find((item) => item.id === projectId);
    setState(project === undefined ? { status: "missing" } : { status: "ready", project });
  }

  useEffect(() => {
    void load();
  }, [api, projectId]);

  return (
    <main className="min-w-0 px-4 py-6 md:px-8">
      <a className="text-sm text-muted" href="/">
        Back to projects
      </a>
      {state.status === "loading" ? (
        <p className="mt-6" aria-busy="true">
          Loading project…
        </p>
      ) : null}
      {state.status === "unauthorized" ? (
        <section className="mt-6 min-w-0">
          <h1 className="text-2xl font-semibold">Sign-in is required</h1>
          <p className="mt-2 max-w-xl text-sm text-muted">
            Production sign-in is not available yet. The Project service requires an authenticated
            caller.
          </p>
        </section>
      ) : null}
      {state.status === "error" ? (
        <section className="mt-6 min-w-0">
          <h1 className="text-2xl font-semibold">Project could not be opened</h1>
          <p className="overflow-anywhere mt-2 text-sm text-muted">{state.message}</p>
          <Button className="mt-4" onClick={() => void load()}>
            Retry
          </Button>
        </section>
      ) : null}
      {state.status === "missing" ? (
        <section className="mt-6 min-w-0">
          <h1 className="text-2xl font-semibold">Project is not available</h1>
          <p className="mt-2 text-sm text-muted">
            It is not in the project list returned for this caller.
          </p>
        </section>
      ) : null}
      {state.status === "ready" ? (
        <section className="mt-6 min-w-0">
          <p className="text-sm text-muted">{roleName(state.project.role)}</p>
          <h1 className="min-w-0 overflow-anywhere text-2xl font-semibold">{state.project.name}</h1>
          <MediaWorkspace
            project={state.project}
            api={api}
            onUploaded={uploaded}
            {...(hashFile === undefined ? {} : { hashFile })}
            {...(putObject === undefined ? {} : { putObject })}
          />
          <MediaLibrary projectId={state.project.id} refreshToken={libraryRevision} />
        </section>
      ) : null}
    </main>
  );
}

function roleName(role: ProjectRecord["role"]): string {
  if (role === "owner") {
    return "Owner";
  }
  if (role === "editor") {
    return "Editor";
  }
  return "Viewer";
}
