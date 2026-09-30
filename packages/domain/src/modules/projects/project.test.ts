import assert from "node:assert/strict";
import { test } from "node:test";
import { instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { projectId, userId } from "../../kernel/id.js";
import { membershipRole, Project, visibleProjects } from "./project.js";

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
