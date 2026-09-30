import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DomainError,
  instant,
  type Instant,
  Project,
  ProjectConflict,
  projectId,
  type ProjectId,
  userId,
  uuidV7,
} from "@editagent/domain";
import { type Clock, type ProjectIdGenerator } from "./clock.js";
import { InMemoryProjectRepository } from "./in-memory-project-repository.js";
import { ProjectForbiddenError, ProjectNotFoundError } from "./project-access.js";
import { CreateProject, DeleteProject, ListProjects, RenameProject } from "./projects.js";

const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");
const ADMIN = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const FIRST = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const SECOND = projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f");

class ManualClock implements Clock {
  constructor(private current: Instant) {}

  now(): Instant {
    return this.current;
  }

  set(next: Instant): void {
    this.current = next;
  }
}

class SequenceIds implements ProjectIdGenerator {
  private index = 0;

  constructor(private readonly ids: readonly ProjectId[]) {}

  next(): ProjectId {
    const id = this.ids[this.index];
    this.index += 1;
    if (id === undefined) {
      throw new Error("The test id sequence is exhausted.");
    }
    return id;
  }
}

function harness(ids: readonly ProjectId[] = [FIRST, SECOND]) {
  const projects = new InMemoryProjectRepository();
  const clock = new ManualClock(instant(10n));
  const createProject = new CreateProject(projects, new SequenceIds(ids), clock);
  const renameProject = new RenameProject(projects, clock);
  const listProjects = new ListProjects(projects);
  const deleteProject = new DeleteProject(projects, clock);
  return { projects, clock, createProject, renameProject, listProjects, deleteProject };
}

test("CreateProject records the caller as Owner with a UUIDv7", async () => {
  const { createProject, projects } = harness();
  const project = await createProject.execute(OWNER, "  Launch  ");
  assert.equal(project.id, FIRST);
  assert.equal(project.id, uuidV7(project.id));
  assert.equal(project.name, "Launch");
  assert.equal(project.roleOf(OWNER), "owner");
  assert.equal(project.memberships.length, 1);
  assert.equal(project.createdAt, 10n);
  assert.equal(project.updatedAt, 10n);
  assert.equal(project.deletedAt, null);
  const stored = await projects.findById(project.id);
  assert.equal(stored?.roleOf(OWNER), "owner");
  await assert.rejects(() => createProject.execute(OWNER, "   "), DomainError);
});

test("CreateProject saves one aggregate that already contains the Owner", async () => {
  const saved: Project[] = [];
  const repository = {
    async findById() {
      return null;
    },
    async listForMember() {
      return [];
    },
    async save(project: Project, expectedUpdatedAt: Instant | null) {
      assert.equal(expectedUpdatedAt, null);
      assert.equal(project.memberships.length, 1);
      assert.equal(project.roleOf(OWNER), "owner");
      saved.push(project);
    },
  };
  const createProject = new CreateProject(
    repository,
    new SequenceIds([FIRST]),
    new ManualClock(instant(10n)),
  );
  await createProject.execute(OWNER, "Launch");
  assert.equal(saved.length, 1);
});

test("RenameProject allows Owner and Editor and rejects Viewer without leaking non-members", async () => {
  const { createProject, renameProject, projects, clock } = harness();
  const project = await createProject.execute(OWNER, "Launch");
  clock.set(instant(20n));
  const withEditor = (await projects.findById(project.id))!.grantMembership(
    OWNER,
    EDITOR,
    "editor",
    instant(20n),
  );
  await projects.save(withEditor, project.updatedAt);
  clock.set(instant(30n));
  const withViewer = (await projects.findById(project.id))!.grantMembership(
    OWNER,
    VIEWER,
    "viewer",
    instant(30n),
  );
  await projects.save(withViewer, withEditor.updatedAt);

  clock.set(instant(40n));
  const byEditor = await renameProject.execute(EDITOR, project.id, "Cut");
  assert.equal(byEditor.name, "Cut");
  assert.equal(byEditor.updatedAt, 40n);

  clock.set(instant(50n));
  const byOwner = await renameProject.execute(OWNER, project.id, "Final");
  assert.equal(byOwner.name, "Final");

  await assert.rejects(
    () => renameProject.execute(VIEWER, project.id, "Nope"),
    ProjectForbiddenError,
  );
  assert.equal((await projects.findById(project.id))?.name, "Final");

  await assert.rejects(
    () => renameProject.execute(ADMIN, project.id, "Nope"),
    ProjectNotFoundError,
  );
  await assert.rejects(() => renameProject.execute(OWNER, SECOND, "Missing"), ProjectNotFoundError);
});

test("RenameProject rejects a deleted Project and a backward timestamp", async () => {
  const { createProject, renameProject, deleteProject, projects, clock } = harness();
  const project = await createProject.execute(OWNER, "Launch");
  clock.set(instant(5n));
  await assert.rejects(() => renameProject.execute(OWNER, project.id, "Back"), DomainError);
  assert.equal((await projects.findById(project.id))?.updatedAt, 10n);

  clock.set(instant(10n));
  const same = await renameProject.execute(OWNER, project.id, "Same");
  assert.equal(same.updatedAt, 10n);
  assert.equal(same.name, "Same");

  clock.set(instant(20n));
  await deleteProject.execute(OWNER, project.id);
  await assert.rejects(
    () => renameProject.execute(OWNER, project.id, "Again"),
    ProjectNotFoundError,
  );
  await assert.rejects(
    () => renameProject.execute(ADMIN, project.id, "Again"),
    ProjectNotFoundError,
  );
});

test("RenameProject does not overwrite a Project that changed after it was loaded", async () => {
  const visible = Project.create(FIRST, "Launch", OWNER, instant(10n));
  const stored = visible.rename(OWNER, "Other", instant(15n));
  let savedExpected: Instant | null = null;
  const repository = {
    async findById() {
      return visible;
    },
    async listForMember() {
      return [];
    },
    async save(project: Project, expectedUpdatedAt: Instant | null) {
      savedExpected = expectedUpdatedAt;
      if (expectedUpdatedAt === null || stored.updatedAt !== expectedUpdatedAt) {
        throw new ProjectConflict();
      }
      void project;
    },
  };
  const renameProject = new RenameProject(repository, new ManualClock(instant(20n)));
  await assert.rejects(() => renameProject.execute(OWNER, FIRST, "Lost"), ProjectConflict);
  assert.equal(savedExpected, visible.updatedAt);
  assert.equal(stored.name, "Other");
});

test("ListProjects returns only the caller memberships and hides deleted Projects", async () => {
  const { createProject, listProjects, deleteProject, projects, clock } = harness();
  const owned = await createProject.execute(OWNER, "Owned");
  clock.set(instant(11n));
  const shared = await createProject.execute(EDITOR, "Shared");
  const granted = shared.grantMembership(EDITOR, OWNER, "viewer", instant(11n));
  await projects.save(granted, shared.updatedAt);

  const ownerList = await listProjects.execute(OWNER);
  assert.deepEqual(
    ownerList.map((project) => project.name),
    ["Owned", "Shared"],
  );
  const editorList = await listProjects.execute(EDITOR);
  assert.deepEqual(
    editorList.map((project) => project.name),
    ["Shared"],
  );
  assert.deepEqual(await listProjects.execute(ADMIN), []);

  clock.set(instant(20n));
  await deleteProject.execute(OWNER, owned.id);
  assert.deepEqual(
    (await listProjects.execute(OWNER)).map((project) => project.name),
    ["Shared"],
  );
  const hidden = await projects.findById(owned.id);
  assert.equal(hidden?.deletedAt, 20n);
  assert.equal(hidden?.isListed(), false);
});

test("DeleteProject is a soft delete allowed only for the Owner", async () => {
  const { createProject, deleteProject, listProjects, projects, clock } = harness();
  const project = await createProject.execute(OWNER, "Launch");
  clock.set(instant(20n));
  const withEditor = (await projects.findById(project.id))!.grantMembership(
    OWNER,
    EDITOR,
    "editor",
    instant(20n),
  );
  await projects.save(withEditor, project.updatedAt);
  clock.set(instant(30n));
  const withViewer = (await projects.findById(project.id))!.grantMembership(
    OWNER,
    VIEWER,
    "viewer",
    instant(30n),
  );
  await projects.save(withViewer, withEditor.updatedAt);

  await assert.rejects(() => deleteProject.execute(EDITOR, project.id), ProjectForbiddenError);
  await assert.rejects(() => deleteProject.execute(VIEWER, project.id), ProjectForbiddenError);
  await assert.rejects(() => deleteProject.execute(ADMIN, project.id), ProjectNotFoundError);
  assert.equal((await listProjects.execute(OWNER)).length, 1);

  clock.set(instant(40n));
  await deleteProject.execute(OWNER, project.id);
  const stored = await projects.findById(project.id);
  assert.equal(stored?.deletedAt, 40n);
  assert.equal(stored?.updatedAt, 40n);
  assert.equal(stored?.memberships.length, 3);
  assert.deepEqual(await listProjects.execute(OWNER), []);
  await assert.rejects(() => deleteProject.execute(OWNER, project.id), ProjectNotFoundError);
});
