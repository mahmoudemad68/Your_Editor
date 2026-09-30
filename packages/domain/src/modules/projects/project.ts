/**
 * Project aggregate. Creating a Project records the authenticated User as Owner.
 * Only an Owner manages membership. Admin is not a membership role.
 * Delete is a soft delete. There is no archive operation.
 */

import { type AuditStamp, type Instant, instant } from "../../kernel/clock.js";
import { DomainError } from "../../kernel/error.js";
import { type ProjectId, type UserId } from "../../kernel/id.js";

export type ProjectMembershipRole = "owner" | "editor" | "viewer";

export interface ProjectMembership {
  readonly userId: UserId;
  readonly role: ProjectMembershipRole;
  readonly createdAt: Instant;
}

export class Project {
  readonly id: ProjectId;
  readonly name: string;
  readonly memberships: readonly ProjectMembership[];
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly deletedAt: Instant | null;

  private constructor(
    id: ProjectId,
    name: string,
    memberships: readonly ProjectMembership[],
    audit: AuditStamp,
    deletedAt: Instant | null,
  ) {
    this.id = id;
    this.name = name;
    this.memberships = memberships;
    this.createdAt = audit.createdAt;
    this.updatedAt = audit.updatedAt;
    this.deletedAt = deletedAt;
  }

  /**
   * An authenticated User creates a Project and becomes its Owner in the same operation.
   */
  static create(id: ProjectId, name: string, ownerUserId: UserId, createdAt: Instant): Project {
    const stamp = instant(createdAt);
    const title = requireName(name);
    const membership: ProjectMembership = {
      userId: ownerUserId,
      role: "owner",
      createdAt: stamp,
    };
    return new Project(id, title, [membership], { createdAt: stamp, updatedAt: stamp }, null);
  }

  isListed(): boolean {
    return this.deletedAt === null;
  }

  roleOf(userId: UserId): ProjectMembershipRole | null {
    if (this.deletedAt !== null) {
      return null;
    }
    return this.memberships.find((membership) => membership.userId === userId)?.role ?? null;
  }

  grantMembership(
    actorUserId: UserId,
    memberUserId: UserId,
    role: ProjectMembershipRole,
    at: Instant,
  ): Project {
    this.requireOwner(actorUserId);
    const when = instant(at);
    const existing = this.memberships.find((membership) => membership.userId === memberUserId);
    const next = existing
      ? this.memberships.map((membership) =>
          membership.userId === memberUserId ? { ...membership, role } : membership,
        )
      : [...this.memberships, { userId: memberUserId, role, createdAt: when }];
    this.requireOneOwner(next);
    return this.copy(next, when, this.deletedAt);
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
    this.requireOneOwner(next);
    return this.copy(next, instant(at), this.deletedAt);
  }

  /** Soft delete. Object-storage bytes are not removed here (US-104, US-120). */
  deleteProject(actorUserId: UserId, at: Instant): Project {
    if (this.deletedAt !== null) {
      throw new DomainError("The Project is already deleted.");
    }
    this.requireOwner(actorUserId);
    const when = instant(at);
    return this.copy(this.memberships, when, when);
  }

  private requireOwner(actorUserId: UserId): void {
    if (this.deletedAt !== null) {
      throw new DomainError("A deleted Project cannot change membership.");
    }
    if (this.roleOf(actorUserId) !== "owner") {
      throw new DomainError("Only an Owner can manage Project membership.");
    }
  }

  private requireOneOwner(memberships: readonly ProjectMembership[]): void {
    const owners = memberships.filter((membership) => membership.role === "owner");
    if (owners.length < 1) {
      throw new DomainError("A Project must keep at least one Owner.");
    }
  }

  private copy(
    memberships: readonly ProjectMembership[],
    updatedAt: Instant,
    deletedAt: Instant | null,
  ): Project {
    return new Project(
      this.id,
      this.name,
      memberships,
      { createdAt: this.createdAt, updatedAt },
      deletedAt,
    );
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

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new DomainError("A Project name is required.");
  }
  return trimmed;
}
