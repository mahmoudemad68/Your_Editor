import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { after, test } from "node:test";
import { fetchWithTestActor } from "./test-actor-fetch.mjs";

const root = path.resolve(".");
const apiRequire = createRequire(path.join(root, "apps/api/package.json"));
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
webRequire(path.join(root, "apps/web/dist-test/presentation/dom-setup.js"));
const React = webRequire("react");
const { cleanup, fireEvent, render, screen } = webRequire("@testing-library/react");
const domain = apiRequire(path.join(root, "packages/domain/dist/index.js"));
const { createApiApplication } = apiRequire(
  path.join(root, "apps/api/dist/create-api-application.js"),
);
const { bindActor } = apiRequire(path.join(root, "apps/api/dist/presentation/actor.js"));
const { InMemoryProjectRepository } = apiRequire(
  path.join(root, "apps/api/dist/application/in-memory-project-repository.js"),
);
const { InMemoryMediaAssetRepository } = apiRequire(
  path.join(root, "apps/api/dist/application/in-memory-media-repository.js"),
);
const { MemoryObjectStorage } = apiRequire(
  path.join(root, "apps/api/dist/application/memory-object-storage.js"),
);
const { Dashboard } = webRequire(path.join(root, "apps/web/dist-test/presentation/dashboard.js"));
const { createHttpProjectApi } = webRequire(
  path.join(root, "apps/web/dist-test/infrastructure/project-api.js"),
);

const OWNER = "018f6b6e-7c3a-7111-8d3e-9c0b1a2d3e4f";

after(() => {
  cleanup();
});

test("the dashboard uses the Project API and creates a project without a page reload", async () => {
  const projects = new InMemoryProjectRepository();
  const app = await createApiApplication(
    {
      projects,
      clock: { now: () => domain.instant(1_700_000_000_000n) },
      ids: { next: () => domain.projectId("018f6b6e-7c3a-7b2a-8d3e-9c0b1a2d3e4f") },
      media: new InMemoryMediaAssetRepository(),
      objects: new MemoryObjectStorage(),
      mediaIds: { next: () => domain.mediaAssetId("018f6b6e-7c3a-7b2c-8d3e-9c0b1a2d3e4f") },
      presignTtlSeconds: 900,
    },
    (use) => {
      use((request, _response, next) => {
        const header = request.headers?.["x-test-actor"];
        if (typeof header === "string") {
          bindActor(request, domain.userId(header));
        }
        next();
      });
    },
  );
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const anonymous = createHttpProjectApi({ baseUrl: base });
    render(React.createElement(Dashboard, { api: anonymous }));
    await screen.findByRole("heading", { name: "Sign-in is required" });
    cleanup();

    await projects.save(
      domain.Project.create(
        domain.projectId("018f6b6e-7c3a-7b2b-8d3e-9c0b1a2d3e4f"),
        "Existing",
        domain.userId(OWNER),
        domain.instant(1_700_000_000_000n),
      ),
      null,
    );
    const api = createHttpProjectApi({
      baseUrl: base,
      fetchImpl: fetchWithTestActor(OWNER),
    });
    render(React.createElement(Dashboard, { api }));
    await screen.findByRole("heading", { name: "Existing" });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await screen.findByRole("heading", { name: "Launch" });
    assert.ok(screen.getByRole("heading", { name: "Existing" }));
    const listed = await api.listProjects();
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.deepEqual(listed.data.map((project) => project.name).sort(), ["Existing", "Launch"]);
    }
  } finally {
    cleanup();
    await app.close();
  }
});
