import "reflect-metadata";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { type INestApplication } from "@nestjs/common";
import {
  instant,
  type Instant,
  mediaAssetId,
  Project,
  type ProjectId,
  projectId,
  type UserId,
  userId,
} from "@editagent/domain";
import {
  type Clock,
  type MediaAssetIdGenerator,
  type ProjectIdGenerator,
} from "../application/clock.js";
import { InMemoryMediaAssetRepository } from "../application/in-memory-media-repository.js";
import { InMemoryProjectRepository } from "../application/in-memory-project-repository.js";
import { MemoryObjectStorage } from "../application/memory-object-storage.js";
import { createApiApplication } from "../create-api-application.js";
import { bindActor } from "./actor.js";

const OWNER = userId("018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f");
const EDITOR = userId("018f6b6e-7c3a-7222-8d3e-9c0b1a2d3e4f");
const VIEWER = userId("018f6b6e-7c3a-7333-8d3e-9c0b1a2d3e4f");
const STRANGER = userId("018f6b6e-7c3a-7444-8d3e-9c0b1a2d3e4f");
const PROJECT = projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f");

class ManualClock implements Clock {
  constructor(private current: Instant) {}

  now(): Instant {
    return this.current;
  }
}

class OneId implements ProjectIdGenerator {
  next(): typeof PROJECT {
    return PROJECT;
  }
}

class FixedMediaId implements MediaAssetIdGenerator {
  next(): ReturnType<MediaAssetIdGenerator["next"]> {
    return mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f");
  }
}

function uploadDependencies() {
  return {
    media: new InMemoryMediaAssetRepository(),
    objects: new MemoryObjectStorage(),
    mediaIds: new FixedMediaId(),
    presignTtlSeconds: 900,
  };
}

interface ProjectBody {
  id: string;
  name: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

describeState();

function describeState(): void {
  let app: INestApplication;
  let base: string;
  const projects = new InMemoryProjectRepository();

  before(async () => {
    app = await createApiApplication(
      {
        projects,
        clock: new ManualClock(instant(10n)),
        ids: new OneId(),
        ...uploadDependencies(),
      },
      (use) => {
        use((request, _response, next) => {
          const headers = (request as { headers?: Record<string, string | string[] | undefined> })
            .headers;
          const header = headers?.["x-test-actor"];
          if (typeof header === "string") {
            bindActor(request, userId(header));
          }
          next();
        });
      },
    );
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected the test server to listen on a TCP port.");
    }
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await app.close();
  });

  test("project routes delegate to use cases and do not trust a body user id", async () => {
    const missingActor = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Launch" }),
    });
    assert.equal(missingActor.status, 401);

    const forged = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": OWNER },
      body: JSON.stringify({ name: "Launch", actorUserId: STRANGER }),
    });
    assert.equal(forged.status, 400);

    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": OWNER },
      body: JSON.stringify({ name: "  Launch  " }),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as ProjectBody;
    assert.equal(body.id, PROJECT);
    assert.equal(body.name, "Launch");
    assert.equal(body.role, "owner");
    assert.equal(body.createdAt, "10");
    assert.equal(body.updatedAt, "10");
    assert.equal("deletedAt" in body, false);
    assert.equal("memberships" in body, false);

    const listed = await fetch(`${base}/projects`, { headers: { "x-test-actor": OWNER } });
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as { projects: ProjectBody[] };
    assert.equal(listBody.projects.length, 1);
    assert.equal(listBody.projects[0]?.role, "owner");

    const stranger = await fetch(`${base}/projects/${PROJECT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-actor": STRANGER },
      body: JSON.stringify({ name: "Hidden" }),
    });
    const strangerBody = (await stranger.json()) as { message: string };
    assert.equal(stranger.status, 404);
    const missing = await fetch(
      `${base}/projects/${projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f")}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-test-actor": OWNER },
        body: JSON.stringify({ name: "Missing" }),
      },
    );
    const missingBody = (await missing.json()) as { message: string };
    assert.equal(missing.status, 404);
    assert.equal(missingBody.message, strangerBody.message);

    const malformed = await fetch(`${base}/projects/not-a-uuid`, {
      method: "DELETE",
      headers: { "x-test-actor": OWNER },
    });
    assert.equal(malformed.status, 400);

    const loaded = await projects.findById(PROJECT);
    await projects.save(
      loaded!.project.grantMembership(OWNER, EDITOR, "editor", instant(10n)),
      loaded!.revision,
    );
    const withEditor = await projects.findById(PROJECT);
    await projects.save(
      withEditor!.project.grantMembership(OWNER, VIEWER, "viewer", instant(10n)),
      withEditor!.revision,
    );

    const viewer = await fetch(`${base}/projects/${PROJECT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-actor": VIEWER },
      body: JSON.stringify({ name: "Nope" }),
    });
    assert.equal(viewer.status, 403);

    const editorDelete = await fetch(`${base}/projects/${PROJECT}`, {
      method: "DELETE",
      headers: { "x-test-actor": EDITOR },
    });
    assert.equal(editorDelete.status, 403);

    const renamed = await fetch(`${base}/projects/${PROJECT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-actor": EDITOR },
      body: JSON.stringify({ name: "Cut" }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as ProjectBody).name, "Cut");

    const deleted = await fetch(`${base}/projects/${PROJECT}`, {
      method: "DELETE",
      headers: { "x-test-actor": OWNER },
    });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), "");
    const afterDelete = await fetch(`${base}/projects`, { headers: { "x-test-actor": OWNER } });
    const remaining = (await afterDelete.json()) as { projects: ProjectBody[] };
    assert.deepEqual(remaining.projects, []);
    const stored = await projects.findById(PROJECT);
    assert.equal(stored?.project.deletedAt, 10n);
    assert.equal(stored?.project.memberships.length, 3);
  });
}

test("a stale Project revision returns HTTP 409 from the controller", async () => {
  const inner = new InMemoryProjectRepository();
  const repository = {
    async findById(id: ProjectId) {
      const loaded = await inner.findById(id);
      if (loaded === null) {
        return null;
      }
      const raced = loaded.project.rename(OWNER, "Raced", loaded.project.updatedAt);
      await inner.save(raced, loaded.revision);
      return loaded;
    },
    async listForMember(userId: UserId) {
      return inner.listForMember(userId);
    },
    async save(project: Project, expectedRevision: bigint | null) {
      return inner.save(project, expectedRevision);
    },
  };
  const app = await createApiApplication(
    {
      projects: repository,
      clock: new ManualClock(instant(10n)),
      ids: new OneId(),
      ...uploadDependencies(),
    },
    (use) => {
      use((request, _response, next) => {
        const headers = (request as { headers?: Record<string, string | string[] | undefined> })
          .headers;
        const header = headers?.["x-test-actor"];
        if (typeof header === "string") {
          bindActor(request, userId(header));
        }
        next();
      });
    },
  );
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected the test server to listen on a TCP port.");
  }
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-actor": OWNER },
      body: JSON.stringify({ name: "Launch" }),
    });
    assert.equal(created.status, 201);
    const conflict = await fetch(`${base}/projects/${PROJECT}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-test-actor": OWNER },
      body: JSON.stringify({ name: "Lost" }),
    });
    const body = (await conflict.json()) as { statusCode: number; message: string };
    assert.equal(conflict.status, 409);
    assert.equal(body.statusCode, 409);
    assert.equal(body.message, "The Project changed since it was loaded.");
    assert.equal(JSON.stringify(body).toLowerCase().includes("select"), false);
    assert.equal(JSON.stringify(body).includes("revision"), false);
    const stored = await inner.findById(PROJECT);
    assert.equal(stored?.project.name, "Raced");
    assert.equal(stored?.revision, 1n);
  } finally {
    await app.close();
  }
});
