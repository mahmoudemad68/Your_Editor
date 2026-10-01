import "./dom-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ApiResult, ProjectApi, ProjectRecord } from "../project-contract";
import { Dashboard } from "./dashboard";
import { ProjectScreen } from "./project-screen";
import { AppShell } from "./shell";

const LONG_NAME = `项目${"字".repeat(420)}`;

const OWNER_PROJECT = project("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f", "Launch", "owner");
const EDITOR_PROJECT = project("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f", "Assembly", "editor");
const VIEWER_PROJECT = project("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f", "Review", "viewer");

function project(id: string, name: string, role: ProjectRecord["role"]): ProjectRecord {
  return {
    id,
    name,
    role,
    createdAt: "1700000000000",
    updatedAt: "1700000000000",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("the dashboard shows a loading state and then real project fields", async () => {
  const pending = deferred<ApiResult<readonly ProjectRecord[]>>();
  const api = fakeApi({ list: () => pending.promise });
  render(<Dashboard api={api} />);
  assert.ok(screen.getByText("Loading projects…"));
  pending.resolve({ ok: true, data: [OWNER_PROJECT, EDITOR_PROJECT, VIEWER_PROJECT] });
  await screen.findByRole("heading", { name: "Launch" });
  await screen.findByRole("heading", { name: "Assembly" });
  assert.equal(screen.getByText("Owner").textContent, "Owner");
  assert.equal(screen.getByText("Editor").textContent, "Editor");
  assert.equal(screen.getByText("Viewer").textContent, "Viewer");
  assert.equal(
    screen.getAllByRole("link", { name: "Open project" })[0]?.getAttribute("href"),
    `/projects/${OWNER_PROJECT.id}`,
  );
  assert.equal(screen.getAllByRole("button", { name: "Delete" }).length, 1);
  cleanup();
});

test("an empty project list offers creation", async () => {
  render(<Dashboard api={fakeApi({ list: async () => ({ ok: true, data: [] }) })} />);
  await screen.findByRole("heading", { name: "No projects yet" });
  cleanup();
});

test("a network failure can be retried", async () => {
  let calls = 0;
  const api = fakeApi({
    list: async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 0, message: "The Project service could not be reached." };
      }
      return { ok: true, data: [OWNER_PROJECT] };
    },
  });
  render(<Dashboard api={api} />);
  await screen.findByRole("heading", { name: "Projects could not be loaded" });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Launch" });
  cleanup();
});

test("an unauthorized response is not an empty dashboard", async () => {
  render(
    <Dashboard
      api={fakeApi({
        list: async () => ({ ok: false, status: 401, message: "Sign in is required." }),
      })}
    />,
  );
  await screen.findByRole("heading", { name: "Sign-in is required" });
  assert.equal(screen.queryByRole("heading", { name: "No projects yet" }), null);
  cleanup();
});

test("create validates, submits once, and adds the confirmed project", async () => {
  let creates = 0;
  const api = fakeApi({
    list: async () => ({ ok: true, data: [] }),
    create: async (name) => {
      creates += 1;
      return { ok: true, data: project("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f", name, "owner") };
    },
  });
  render(<Dashboard api={api} />);
  await screen.findByRole("heading", { name: "No projects yet" });
  fireEvent.click(screen.getAllByRole("button", { name: "Create project" })[0]!);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  assert.ok(screen.getByRole("alert").textContent?.includes("A Project name is required."));
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  Cut  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await screen.findByRole("heading", { name: "Cut" });
  assert.equal(creates, 1);
  cleanup();
});

test("a rejected create stays in the dialog", async () => {
  const api = fakeApi({
    list: async () => ({ ok: true, data: [] }),
    create: async () => ({
      ok: false,
      status: 409,
      message: "The Project changed since it was loaded.",
    }),
  });
  render(<Dashboard api={api} />);
  await screen.findByText("No projects yet");
  fireEvent.click(screen.getAllByRole("button", { name: "Create project" })[0]!);
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Cut" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await screen.findByRole("alert");
  assert.equal(screen.queryByRole("heading", { name: "Cut" }), null);
  cleanup();
});

test("delete asks for confirmation and can be cancelled", async () => {
  let deletes = 0;
  const api = fakeApi({
    list: async () => ({ ok: true, data: [OWNER_PROJECT] }),
    remove: async () => {
      deletes += 1;
      return { ok: true, data: undefined };
    },
  });
  render(<Dashboard api={api} />);
  await screen.findByRole("heading", { name: "Launch" });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    assert.equal(screen.queryByRole("heading", { name: "Delete project" }), null),
  );
  assert.ok(screen.getByRole("heading", { name: "Launch" }));
  assert.equal(deletes, 0);
  cleanup();
});

test("a confirmed delete removes the project without reloading the list", async () => {
  let lists = 0;
  const api = fakeApi({
    list: async () => {
      lists += 1;
      return { ok: true, data: [OWNER_PROJECT] };
    },
    remove: async () => ({ ok: true, data: undefined }),
  });
  render(<Dashboard api={api} />);
  await screen.findByRole("heading", { name: "Launch" });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await screen.findByRole("heading", { name: "No projects yet" });
  assert.equal(lists, 1);
  cleanup();
});

test("a refused delete stays on the dashboard and shows the API message", async () => {
  const api = fakeApi({
    list: async () => ({ ok: true, data: [OWNER_PROJECT] }),
    remove: async () => ({
      ok: false,
      status: 403,
      message: "Only an Owner can delete a Project.",
    }),
  });
  render(<Dashboard api={api} />);
  await screen.findByRole("heading", { name: "Launch" });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await screen.findByRole("alert");
  assert.equal(screen.getByRole("alert").textContent, "Only an Owner can delete a Project.");
  assert.ok(screen.getByRole("heading", { name: "Launch" }));
  cleanup();
});

test("mobile navigation can be opened from the header", () => {
  render(
    <AppShell>
      <p>Workspace</p>
    </AppShell>,
  );
  const toggle = screen.getByRole("button", { name: "Open navigation" });
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  fireEvent.click(toggle);
  assert.equal(
    screen.getByRole("button", { name: "Close navigation" }).getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(screen.getByRole("link", { name: "Projects" }).getAttribute("aria-current"), "page");
  cleanup();
});

test("the projects link is current only on the dashboard route", () => {
  render(
    <AppShell currentPath="/projects/018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f">
      <p>Workspace</p>
    </AppShell>,
  );
  assert.equal(screen.getByRole("link", { name: "Projects" }).getAttribute("aria-current"), null);
  cleanup();
});

test("a long uninterrupted project name wraps in the card and delete dialog", async () => {
  const record = project("018f6b6e-7c3a-7b2d-8d3e-9c0b1a2d3e4f", LONG_NAME, "owner");
  render(<Dashboard api={fakeApi({ list: async () => ({ ok: true, data: [record] }) })} />);
  const heading = await screen.findByRole("heading", { name: LONG_NAME });
  assert.ok(heading.className.includes("min-w-0"));
  assert.ok(heading.className.includes("overflow-anywhere"));
  assert.ok(heading.closest("li")?.classList.contains("min-w-0"));
  assert.ok(heading.closest("article")?.classList.contains("min-w-0"));
  const opener = screen.getByRole("button", { name: "Delete" });
  opener.focus();
  fireEvent.click(opener);
  const shown = screen.getAllByText(LONG_NAME, { exact: false });
  assert.ok(shown.length >= 2);
  for (const element of shown) {
    assert.ok(element.className.includes("overflow-anywhere"), element.className);
  }
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    if (document.activeElement !== opener) {
      throw new Error("focus did not return to the delete button");
    }
  });
  cleanup();
});

test("a long project name wraps on the project page", async () => {
  const record = project("018f6b6e-7c3a-7b2d-8d3e-9c0b1a2d3e4f", LONG_NAME, "editor");
  render(
    <ProjectScreen
      projectId={record.id}
      api={fakeApi({ list: async () => ({ ok: true, data: [record] }) })}
    />,
  );
  const heading = await screen.findByRole("heading", { name: LONG_NAME });
  assert.ok(heading.className.includes("overflow-anywhere"));
  assert.equal(screen.queryByRole("button", { name: "Delete" }), null);
  cleanup();
});

test("cancelling create returns focus to the button that opened it", async () => {
  render(<Dashboard api={fakeApi({ list: async () => ({ ok: true, data: [] }) })} />);
  await screen.findByRole("heading", { name: "No projects yet" });
  const opener = screen.getAllByRole("button", { name: "Create project" })[0]!;
  opener.focus();
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    if (document.activeElement !== opener) {
      throw new Error("focus did not return to the create button");
    }
  });
  cleanup();
});

const BETA = project("018f6b6e-7c3a-7b2e-8d3e-9c0b1a2d3e4f", "Beta", "owner");

function headerCreate(): HTMLButtonElement {
  const button = document.getElementById("create-project");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("header Create project button is missing");
  }
  return button;
}

function assertUsableFocus(element: HTMLElement): void {
  if (document.activeElement !== element) {
    throw new Error("focus is not on the expected control");
  }
  assert.equal(element.isConnected, true);
  assert.notEqual(element, document.body);
  if (element instanceof HTMLButtonElement) {
    assert.equal(element.disabled, false);
  }
  assert.equal(element.hidden, false);
  assert.notEqual(element.getAttribute("aria-hidden"), "true");
}

async function openDelete(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name });
  const card = heading.closest("article");
  if (card === null) {
    throw new Error("project card is missing");
  }
  const opener = within(card).getByRole("button", { name: "Delete" });
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("heading", { name: "Delete project" });
  return opener;
}

test("cancelling deletion returns focus to the original delete button", async () => {
  render(<Dashboard api={fakeApi({ list: async () => ({ ok: true, data: [OWNER_PROJECT] }) })} />);
  const opener = await openDelete("Launch");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assertUsableFocus(opener));
  cleanup();
});

test("escape returns focus to the original delete button", async () => {
  render(<Dashboard api={fakeApi({ list: async () => ({ ok: true, data: [OWNER_PROJECT] }) })} />);
  const opener = await openDelete("Launch");
  fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
  await waitFor(() => assertUsableFocus(opener));
  assert.equal(screen.queryByRole("heading", { name: "Delete project" }), null);
  cleanup();
});

test("successful deletion moves focus to the header create button", async () => {
  render(
    <Dashboard
      api={fakeApi({
        list: async () => ({ ok: true, data: [OWNER_PROJECT, BETA] }),
        remove: async () => ({ ok: true, data: undefined }),
      })}
    />,
  );
  await openDelete("Launch");
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await screen.findByRole("heading", { name: "Beta" });
  assert.equal(screen.queryByRole("heading", { name: "Launch" }), null);
  await waitFor(() => assertUsableFocus(headerCreate()));
  cleanup();
});

test("deleting the last card focuses header create and shows the empty state", async () => {
  render(
    <Dashboard
      api={fakeApi({
        list: async () => ({ ok: true, data: [OWNER_PROJECT] }),
        remove: async () => ({ ok: true, data: undefined }),
      })}
    />,
  );
  await openDelete("Launch");
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await screen.findByRole("heading", { name: "No projects yet" });
  await waitFor(() => assertUsableFocus(headerCreate()));
  const creates = screen.getAllByRole("button", { name: "Create project" });
  assert.equal(document.activeElement, creates[0]);
  assert.ok(creates.length > 1);
  cleanup();
});

test("a later cancelled delete still restores the new delete button", async () => {
  render(
    <Dashboard
      api={fakeApi({
        list: async () => ({ ok: true, data: [OWNER_PROJECT, BETA] }),
        remove: async () => ({ ok: true, data: undefined }),
      })}
    />,
  );
  await openDelete("Launch");
  fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
  await screen.findByRole("heading", { name: "Beta" });
  await waitFor(() => assertUsableFocus(headerCreate()));
  const opener = await openDelete("Beta");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => assertUsableFocus(opener));
  cleanup();
});

test("a refused delete keeps the dialog, the card, and focus", async () => {
  for (const status of [403, 409]) {
    const message =
      status === 403
        ? "Only an Owner can delete a Project."
        : "The Project changed since it was loaded.";
    render(
      <Dashboard
        api={fakeApi({
          list: async () => ({ ok: true, data: [OWNER_PROJECT] }),
          remove: async () => ({ ok: false, status, message }),
        })}
      />,
    );
    await openDelete("Launch");
    const confirm = screen.getByRole("button", { name: "Delete project" });
    confirm.focus();
    fireEvent.click(confirm);
    await screen.findByRole("alert");
    assert.equal(screen.getByRole("alert").textContent, message);
    assert.ok(screen.getByRole("heading", { name: "Launch" }));
    await waitFor(() => assertUsableFocus(screen.getByRole("button", { name: "Delete project" })));
    const dialog = screen.getByRole("dialog");
    if (
      !(document.activeElement instanceof HTMLElement) ||
      !dialog.contains(document.activeElement)
    ) {
      throw new Error("focus left the confirmation dialog");
    }
    cleanup();
  }
});

function fakeApi(handlers: {
  list: ProjectApi["listProjects"];
  create?: ProjectApi["createProject"];
  remove?: ProjectApi["deleteProject"];
}): ProjectApi {
  return {
    listProjects: handlers.list,
    createProject:
      handlers.create ?? (async () => ({ ok: false, status: 500, message: "not used" })),
    renameProject: async () => ({ ok: false, status: 500, message: "not used" }),
    deleteProject:
      handlers.remove ?? (async () => ({ ok: false, status: 500, message: "not used" })),
  };
}
