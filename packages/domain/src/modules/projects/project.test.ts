import assert from "node:assert/strict";
import { test } from "node:test";
import { instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { projectId, userId } from "../../kernel/id.js";
import { membershipRole, Project, type ProjectMembership, visibleProjects } from "./project.js";

const NOW = instant(1_700_000_000_000n);
const LATER = instant(1_700_000_100_000n);
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");
const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");

test("creating a Project makes the authenticated User its Owner", () => {
  const project = Project.create(PROJECT, "  Launch  ", OWNER, NOW);
  assert.equal(project.name, "Launch");
  assert.equal(project.roleOf(OWNER), "owner");
  assert.equal(project.memberships.length, 1);
  assert.equal(project.isListed(), true);
  assert.equal(project.deletedAt, null);
});

test("only an Owner manages membership", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW).grantMembership(
    OWNER,
    EDITOR,
    "editor",
    LATER,
  );
  assert.equal(project.roleOf(EDITOR), "editor");
  assert.throws(
    () => project.grantMembership(EDITOR, VIEWER, "viewer", LATER),
    /Only an Owner can manage Project membership/,
  );
  assert.throws(
    () => project.revokeMembership(EDITOR, OWNER, LATER),
    /Only an Owner can manage Project membership/,
  );
});

test("Admin is not a Project membership role", () => {
  assert.throws(() => membershipRole("admin"), /Admin is not a Project role/);
  assert.throws(() => membershipRole("creator"), DomainError);
});

test("soft-deleted Projects leave normal listings and cannot change membership", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW).deleteProject(OWNER, LATER);
  assert.equal(project.isListed(), false);
  assert.equal(project.deletedAt, LATER);
  assert.deepEqual(visibleProjects([project]), []);
  assert.throws(
    () => project.grantMembership(OWNER, EDITOR, "editor", LATER),
    /deleted Project cannot change membership/,
  );
  assert.throws(() => project.deleteProject(OWNER, LATER), /already deleted/);
});

test("an Editor cannot delete a Project", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW).grantMembership(
    OWNER,
    EDITOR,
    "editor",
    LATER,
  );
  assert.throws(() => project.deleteProject(EDITOR, LATER), DomainError);
});

test("a Project name is required", () => {
  assert.throws(() => Project.create(PROJECT, "   ", OWNER, NOW), DomainError);
});

test("grantMembership rejects admin and other non-membership roles at runtime", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW);
  assert.throws(() => project.grantMembership(OWNER, EDITOR, "admin", LATER), /not a Project role/);
  assert.throws(() => project.grantMembership(OWNER, EDITOR, "creator", LATER), DomainError);
});

test("the last Owner cannot be removed or demoted", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW);
  assert.throws(() => project.revokeMembership(OWNER, OWNER, LATER), /last Owner/);
  assert.throws(() => project.grantMembership(OWNER, OWNER, "editor", LATER), /at least one Owner/);
});

test("callers cannot mutate memberships or deleted state behind the aggregate", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW);
  assert.throws(() => {
    (project.memberships as ProjectMembership[]).push({
      userId: EDITOR,
      role: "editor",
      createdAt: LATER,
    });
  }, TypeError);
  assert.throws(() => {
    (project.memberships[0] as { role: string }).role = "admin";
  }, TypeError);
  assert.throws(() => {
    (project as { deletedAt: bigint | null }).deletedAt = null;
  }, TypeError);
  assert.equal(project.roleOf(OWNER), "owner");
  assert.equal(project.deletedAt, null);
});

test("restore rebuilds a soft-deleted Project with several memberships", () => {
  const restored = Project.restore({
    id: PROJECT,
    name: "Launch",
    memberships: [
      { userId: OWNER, role: "owner", createdAt: 1n },
      { userId: EDITOR, role: "editor", createdAt: 2n },
      { userId: VIEWER, role: "viewer", createdAt: 3n },
    ],
    createdAt: 1n,
    updatedAt: 4n,
    deletedAt: 5n,
  });
  assert.equal(restored.createdAt, 1n);
  assert.equal(restored.updatedAt, 4n);
  assert.equal(restored.deletedAt, 5n);
  assert.equal(restored.isListed(), false);
  assert.deepEqual(
    restored.memberships.map((membership) => membership.role),
    ["owner", "editor", "viewer"],
  );
  assert.equal(restored.memberships[1]?.createdAt, 2n);
  assert.throws(
    () =>
      Project.restore({
        id: PROJECT,
        name: "Launch",
        memberships: [{ userId: EDITOR, role: "editor", createdAt: 1n }],
        createdAt: 1n,
        updatedAt: 1n,
        deletedAt: null,
      }),
    /at least one Owner/,
  );
  assert.throws(
    () =>
      Project.restore({
        id: PROJECT,
        name: "Launch",
        memberships: [{ userId: OWNER, role: "admin", createdAt: 1n }],
        createdAt: 1n,
        updatedAt: 1n,
        deletedAt: null,
      }),
    /not a Project role/,
  );
  assert.throws(
    () =>
      Project.restore({
        id: PROJECT,
        name: "Launch",
        memberships: [
          { userId: OWNER, role: "owner", createdAt: 1n },
          { userId: OWNER, role: "editor", createdAt: 2n },
        ],
        createdAt: 1n,
        updatedAt: 1n,
        deletedAt: null,
      }),
    /two memberships/,
  );
  assert.throws(
    () =>
      Project.restore({
        id: "not-a-uuid",
        name: "Launch",
        memberships: [{ userId: OWNER, role: "owner", createdAt: 1n }],
        createdAt: 1n,
        updatedAt: 1n,
        deletedAt: null,
      }),
    DomainError,
  );
});
