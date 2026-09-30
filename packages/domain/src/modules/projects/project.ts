/**
 * Project aggregate. Creating a Project records the authenticated User as Owner.
 * Only an Owner manages membership. Admin is not a membership role.
 * Delete is a soft delete. There is no archive operation.
 * restore rebuilds a persisted Project without replaying commands.
 */

import { type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type ProjectId, projectId, type UserId, userId } from "../../kernel/id.js";

export type ProjectMembershipRole = "owner" | "editor" | "viewer";

export interface ProjectMembership {
  readonly userId: UserId;
  readonly role: ProjectMembershipRole;
  readonly createdAt: Instant;
}

export interface ProjectMembershipSnapshot {
  readonly userId: string;
  readonly role: string;
  readonly createdAt: bigint | string;
}

export interface ProjectSnapshot {
  readonly id: string;
  readonly name: string;
  readonly memberships: readonly ProjectMembershipSnapshot[];
  readonly createdAt: bigint | string;
  readonly updatedAt: bigint | string;
  readonly deletedAt: bigint | string | null;
}

export class Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly memberships: readonly ProjectMembership[];
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly deletedAt: Instant | null;

  private constructor(
    id: ProjectId | string,
    name: string,
    memberships: readonly ProjectMembershipSnapshot[],
    createdAt: Instant | string | bigint,
    updatedAt: Instant | string | bigint,
    deletedAt: Instant | string | bigint | null,
  ) {
    const created = instant(createdAt);
    this.id = projectId(String(id));
    this.name = requireName(name);
    this.memberships = sealMemberships(memberships);
    this.createdAt = created;
    this.updatedAt = instant(updatedAt);
    this.deletedAt = deletedAt == null ? null : instant(deletedAt);
    requireOneOwner(this.memberships);
    Object.freeze(this);
  }

  /**
   * An authenticated User creates a Project and becomes its Owner in the same operation.
   */
  static create(id: ProjectId, name: string, ownerUserId: UserId, createdAt: Instant): Project {
    const stamp = instant(createdAt);
    return new Project(
      id,
      name,
      [{ userId: ownerUserId, role: "owner", createdAt: stamp }],
      stamp,
      stamp,
      null,
    );
  }

  /** Rebuild a persisted Project, including a soft-deleted one, without replaying commands. */
  static restore(snapshot: ProjectSnapshot): Project {
    return new Project(
      snapshot.id,
      snapshot.name,
      snapshot.memberships,
      snapshot.createdAt,
      snapshot.updatedAt,
      snapshot.deletedAt,
    );
  }

  toSnapshot(): ProjectSnapshot {
    return {
      id: this.id,
      name: this.name,
      memberships: this.memberships.map((membership) => ({
        userId: membership.userId,
        role: membership.role,
        createdAt: membership.createdAt,
      })),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      deletedAt: this.deletedAt,
    };
  }

  isListed(): boolean {
    return this.deletedAt === null;
  }

  roleOf(memberId: UserId): ProjectMembershipRole | null {
    if (this.deletedAt !== null) {
      return null;
    }
    return this.memberships.find((membership) => membership.userId === memberId)?.role ?? null;
  }

  grantMembership(actorUserId: UserId, memberUserId: UserId, role: string, at: Instant): Project {
    const checkedRole = membershipRole(role);
    this.requireOwner(actorUserId);
    const when = instant(at);
    const existing = this.memberships.find((membership) => membership.userId === memberUserId);
    const next = existing
      ? this.memberships.map((membership) =>
          membership.userId === memberUserId ? { ...membership, role: checkedRole } : membership,
        )
      : [...this.memberships, { userId: memberUserId, role: checkedRole, createdAt: when }];
    return new Project(this.id, this.name, next, this.createdAt, when, this.deletedAt);
  }

  revokeMembership(actorUserId: UserId, memberUserId: UserId, at: Instant): Project {
    this.requireOwner(actorUserId);
    if (actorUserId === memberUserId && this.roleOf(actorUserId) === "owner") {
      const owners = this.memberships.filter((membership) => membership.role === "owner");
      if (owners.length === 1) {
        throw new DomainError("The last Owner cannot leave the Project.");
      }
    }
    const next = this.memberships.filter((membership) => membership.userId !== memberUserId);
    if (next.length === this.memberships.length) {
      throw new DomainError("That User is not a member of the Project.");
    }
    return new Project(this.id, this.name, next, this.createdAt, instant(at), this.deletedAt);
  }

  /** Soft delete. Object-storage bytes are not removed here (US-104, US-120). */
  deleteProject(actorUserId: UserId, at: Instant): Project {
    if (this.deletedAt !== null) {
      throw new DomainError("The Project is already deleted.");
    }
    this.requireOwner(actorUserId);
    const when = instant(at);
    return new Project(this.id, this.name, this.memberships, this.createdAt, when, when);
  }

  private requireOwner(actorUserId: UserId): void {
    if (this.deletedAt !== null) {
      throw new DomainError("A deleted Project cannot change membership.");
    }
    if (this.roleOf(actorUserId) !== "owner") {
      throw new DomainError("Only an Owner can manage Project membership.");
    }
  }
}

export function membershipRole(value: string): ProjectMembershipRole {
  if (value === "owner" || value === "editor" || value === "viewer") {
    return value;
  }
  throw new DomainError(
    "Project membership role must be owner, editor, or viewer. Admin is not a Project role.",
  );
}

export function visibleProjects(projects: readonly Project[]): readonly Project[] {
  return projects.filter((project) => project.isListed());
}

function sealMemberships(
  memberships: readonly ProjectMembershipSnapshot[],
): readonly ProjectMembership[] {
  const seen = new Set<string>();
  const sealed = memberships.map((membership) => {
    const memberId = userId(String(membership.userId));
    if (seen.has(memberId)) {
      throw new DomainError("A User cannot have two memberships on one Project.");
    }
    seen.add(memberId);
    return Object.freeze({
      userId: memberId,
      role: membershipRole(membership.role),
      createdAt: instant(membership.createdAt),
    });
  });
  return Object.freeze(sealed);
}

function requireOneOwner(memberships: readonly ProjectMembership[]): void {
  const owners = memberships.filter((membership) => membership.role === "owner");
  if (owners.length < 1) {
    throw new DomainError("A Project must keep at least one Owner.");
  }
}

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new DomainError("A Project name is required.");
  }
  return trimmed;
}
