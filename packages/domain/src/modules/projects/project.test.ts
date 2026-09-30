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
  assert.throws(
    () => project.grantMembership(OWNER, EDITOR, "anything", LATER),
    /not a Project role/,
  );
  const withViewer = project.grantMembership(OWNER, VIEWER, "viewer", LATER);
  assert.throws(
    () => withViewer.grantMembership(VIEWER, OWNER, "editor", LATER),
    /Only an Owner can manage Project membership/,
  );
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
    deletedAt: 4n,
  });
  assert.equal(restored.createdAt, 1n);
  assert.equal(restored.updatedAt, 4n);
  assert.equal(restored.deletedAt, 4n);
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
});

test("restore preserves an exact soft-deleted history and rejects impossible order", () => {
  const restored = Project.restore({
    id: PROJECT,
    name: "Launch",
    memberships: [
      { userId: OWNER, role: "owner", createdAt: "10" },
      { userId: EDITOR, role: "editor", createdAt: "20" },
      { userId: VIEWER, role: "viewer", createdAt: "30" },
    ],
    createdAt: "10",
    updatedAt: "40",
    deletedAt: "40",
  });
  assert.equal(restored.createdAt, 10n);
  assert.equal(restored.memberships[0]?.createdAt, 10n);
  assert.equal(restored.memberships[1]?.createdAt, 20n);
  assert.equal(restored.memberships[2]?.createdAt, 30n);
  assert.equal(restored.updatedAt, 40n);
  assert.equal(restored.deletedAt, 40n);
  const again = Project.restore(restored.toSnapshot());
  assert.equal(again.deletedAt, 40n);
  assert.equal(again.memberships[2]?.createdAt, 30n);

  const active = Project.restore({
    id: PROJECT,
    name: "Launch",
    memberships: [
      { userId: OWNER, role: "owner", createdAt: 10n },
      { userId: EDITOR, role: "editor", createdAt: 20n },
    ],
    createdAt: 10n,
    updatedAt: 20n,
    deletedAt: null,
  });
  assert.equal(active.deletedAt, null);
  assert.equal(active.memberships[1]?.createdAt, 20n);

  const base = {
    id: PROJECT,
    name: "Launch",
    memberships: [{ userId: OWNER, role: "owner", createdAt: 10n }],
    createdAt: 10n,
    updatedAt: 10n,
    deletedAt: null,
  };
  assert.throws(() => Project.restore({ ...base, updatedAt: 9n }), /createdAt must be less than/);
  assert.throws(
    () =>
      Project.restore({
        ...base,
        memberships: [{ userId: OWNER, role: "owner", createdAt: 9n }],
      }),
    /between Project createdAt and updatedAt/,
  );
  assert.throws(
    () =>
      Project.restore({
        ...base,
        updatedAt: 30n,
        memberships: [{ userId: OWNER, role: "owner", createdAt: 40n }],
      }),
    /between Project createdAt and updatedAt/,
  );
  assert.throws(
    () => Project.restore({ ...base, updatedAt: 20n, deletedAt: 15n }),
    /deletedAt equal to updatedAt/,
  );
  assert.throws(
    () => Project.restore({ ...base, updatedAt: 20n, deletedAt: 25n }),
    /deletedAt equal to updatedAt/,
  );
  assert.throws(
    () => Project.restore({ ...base, updatedAt: 20n, deletedAt: 5n }),
    /deletedAt equal to updatedAt/,
  );
});

test("mutating a snapshot does not change the Project", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW);
  const snapshot = project.toSnapshot();
  const mutable = snapshot as unknown as {
    name: string;
    createdAt: bigint;
    updatedAt: bigint;
    deletedAt: bigint | null;
    memberships: { role: string }[];
  };
  mutable.name = "Hacked";
  mutable.createdAt = 0n;
  mutable.updatedAt = 0n;
  mutable.deletedAt = 1n;
  mutable.memberships[0]!.role = "viewer";
  assert.equal(project.name, "Launch");
  assert.equal(project.createdAt, NOW);
  assert.equal(project.updatedAt, NOW);
  assert.equal(project.deletedAt, null);
  assert.equal(project.roleOf(OWNER), "owner");
});

test("frozen Project fields reject assignment", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, NOW);
  assert.throws(() => {
    (project as { name: string }).name = "Hacked";
  }, TypeError);
  assert.throws(() => {
    (project as { createdAt: bigint }).createdAt = 0n;
  }, TypeError);
  assert.throws(() => {
    (project as { updatedAt: bigint }).updatedAt = 0n;
  }, TypeError);
  assert.equal(project.name, "Launch");
});

test("grantMembership rejects a timestamp earlier than Project updatedAt", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, instant(10n))
    .grantMembership(OWNER, EDITOR, "editor", instant(20n))
    .revokeMembership(OWNER, EDITOR, instant(30n));
  assert.equal(project.updatedAt, 30n);
  assert.throws(
    () => project.grantMembership(OWNER, VIEWER, "viewer", instant(25n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.equal(project.updatedAt, 30n);
  assert.equal(project.roleOf(VIEWER), null);
});

test("revokeMembership rejects a timestamp earlier than Project updatedAt", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, instant(10n)).grantMembership(
    OWNER,
    EDITOR,
    "editor",
    instant(30n),
  );
  assert.throws(
    () => project.revokeMembership(OWNER, EDITOR, instant(20n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.equal(project.updatedAt, 30n);
  assert.equal(project.roleOf(EDITOR), "editor");
});

test("deleteProject rejects a timestamp earlier than Project updatedAt", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, instant(10n))
    .grantMembership(OWNER, EDITOR, "editor", instant(20n))
    .revokeMembership(OWNER, EDITOR, instant(30n));
  assert.throws(
    () => project.deleteProject(OWNER, instant(25n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.throws(
    () => project.deleteProject(OWNER, instant(29n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.equal(project.updatedAt, 30n);
  assert.equal(project.deletedAt, null);
});

test("a Project command at the current updatedAt is accepted", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, instant(10n))
    .grantMembership(OWNER, EDITOR, "editor", instant(20n))
    .revokeMembership(OWNER, EDITOR, instant(30n));
  const granted = project.grantMembership(OWNER, VIEWER, "viewer", instant(30n));
  assert.equal(granted.updatedAt, 30n);
  assert.equal(granted.roleOf(VIEWER), "viewer");
  const deleted = project.deleteProject(OWNER, instant(30n));
  assert.equal(deleted.updatedAt, 30n);
  assert.equal(deleted.deletedAt, 30n);
  assert.equal(deleted.isListed(), false);
});

test("a later Project command is accepted", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, instant(10n))
    .grantMembership(OWNER, EDITOR, "editor", instant(20n))
    .revokeMembership(OWNER, EDITOR, instant(30n));
  const granted = project.grantMembership(OWNER, VIEWER, "viewer", instant(40n));
  assert.equal(granted.updatedAt, 40n);
  assert.equal(granted.roleOf(VIEWER), "viewer");
  const deleted = project.deleteProject(OWNER, instant(40n));
  assert.equal(deleted.updatedAt, 40n);
  assert.equal(deleted.deletedAt, 40n);
});

test("removing a membership does not allow a rollback behind Project updatedAt", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, instant(10n))
    .grantMembership(OWNER, EDITOR, "editor", instant(30n))
    .revokeMembership(OWNER, EDITOR, instant(40n));
  assert.equal(project.roleOf(EDITOR), null);
  assert.equal(
    project.memberships.some((membership) => membership.createdAt === 30n),
    false,
  );
  assert.equal(project.updatedAt, 40n);
  assert.throws(
    () => project.grantMembership(OWNER, VIEWER, "viewer", instant(35n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.throws(
    () => project.deleteProject(OWNER, instant(35n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.equal(project.updatedAt, 40n);
  assert.equal(project.deletedAt, null);
});

test("re-granting the existing Owner at an older timestamp is rejected", () => {
  const project = Project.create(PROJECT, "Launch", OWNER, instant(10n))
    .grantMembership(OWNER, EDITOR, "editor", instant(20n))
    .revokeMembership(OWNER, EDITOR, instant(30n));
  assert.equal(project.roleOf(EDITOR), null);
  assert.throws(
    () => project.grantMembership(OWNER, OWNER, "owner", instant(15n)),
    /cannot be earlier than the current updatedAt/,
  );
  assert.equal(project.updatedAt, 30n);
  assert.equal(project.roleOf(OWNER), "owner");
  assert.equal(project.memberships[0]?.createdAt, 10n);
});

test("rename allows Owner and Editor and keeps the aggregate clock monotonic", () => {
  const stranger = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
  const created = Project.create(PROJECT, "Launch", OWNER, instant(10n));
  const withEditor = created.grantMembership(OWNER, EDITOR, "editor", instant(20n));
  const withViewer = withEditor.grantMembership(OWNER, VIEWER, "viewer", instant(30n));

  const byEditor = withViewer.rename(EDITOR, "  Cut  ", instant(30n));
  assert.equal(byEditor.name, "Cut");
  assert.equal(byEditor.updatedAt, 30n);
  assert.equal(byEditor.roleOf(EDITOR), "editor");
  assert.equal(withViewer.name, "Launch");
  assert.equal(withViewer.updatedAt, 30n);

  const byOwner = byEditor.rename(OWNER, "Final", instant(40n));
  assert.equal(byOwner.name, "Final");
  assert.equal(byOwner.updatedAt, 40n);
  assert.equal(byOwner.memberships[0]?.createdAt, 10n);

  assert.throws(() => byOwner.rename(VIEWER, "Nope", instant(50n)), /Owner or Editor/);
  assert.throws(() => byOwner.rename(stranger, "Nope", instant(50n)), /Owner or Editor/);
  assert.throws(() => byOwner.rename(OWNER, "   ", instant(50n)), /name is required/);
  assert.throws(() => byOwner.rename(OWNER, "Back", instant(15n)), /cannot be earlier/);
  assert.equal(byOwner.name, "Final");

  const deleted = byOwner.deleteProject(OWNER, instant(50n));
  assert.throws(() => deleted.rename(OWNER, "Again", instant(60n)), /cannot be renamed/);
  assert.throws(() => deleted.rename(EDITOR, "Again", instant(60n)), /cannot be renamed/);
});

test("placeholder for uuid throws", () => {
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
