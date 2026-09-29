/**
 * Executable copy of docs/architecture/layer-rules.md.
 * The architecture tests load this module and run it against violating fixtures.
 * Keep the rule names stable: the tests and the layer-rules document both use them.
 */

/** @type {import("dependency-cruiser").IForbiddenRuleType[]} */
const forbidden = [
  {
    name: "domain-no-infrastructure",
    severity: "error",
    comment: "Domain must not depend on infrastructure adapters or deployables.",
    from: { path: "(^|/)packages/domain/" },
    to: {
      path: "(^|/)infrastructure/|(^|/)infra/|(^|/)packages/media-core/|(^|/)apps/|(^|/)workers/",
    },
  },
  {
    name: "domain-no-frameworks",
    severity: "error",
    comment: "Domain must not depend on application frameworks or adapter SDKs.",
    from: { path: "(^|/)packages/domain/" },
    to: {
      path: "node_modules/(@nestjs/|next/|react/|react-dom/|express/|bullmq/|ioredis/|typeorm/|prisma/|@prisma/|remotion/|@remotion/)",
    },
  },
  {
    name: "domain-no-npm",
    severity: "error",
    comment: "Domain has no npm dependencies.",
    from: { path: "(^|/)packages/domain/", pathNot: "\\.test\\.(ts|tsx|js)$" },
    to: {
      dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-unknown", "npm-no-pkg"],
    },
  },
  {
    name: "domain-no-node-builtins",
    severity: "error",
    comment: "Production domain code does not depend on Node.js built-ins. Tests may.",
    from: { path: "(^|/)packages/domain/", pathNot: "\\.test\\.(ts|tsx|js)$" },
    to: { dependencyTypes: ["core"] },
  },
  {
    name: "domain-modules-do-not-import-each-other",
    severity: "error",
    comment: "A bounded module may import the kernel and itself, not another module.",
    from: { path: "packages/domain/src/modules/([^/]+)/" },
    to: {
      path: "packages/domain/src/modules/([^/]+)/",
      pathNot: "packages/domain/src/modules/$1/",
    },
  },
  {
    name: "domain-kernel-does-not-import-modules",
    severity: "error",
    comment: "The shared kernel is inner to every module.",
    from: { path: "packages/domain/src/kernel/" },
    to: { path: "packages/domain/src/modules/" },
  },
  {
    name: "domain-no-sibling-packages",
    severity: "error",
    comment: "Domain does not depend on shared, schemas, or tool-sdk.",
    from: { path: "(^|/)packages/domain/" },
    to: { path: "(^|/)packages/(shared|schemas|tool-sdk)/" },
  },
  {
    name: "application-no-outer-layers",
    severity: "error",
    comment: "Application depends inward. Adapters and delivery frameworks stay outside.",
    from: { path: "(^|/)application/", pathNot: "node_modules" },
    to: {
      path: "(^|/)infrastructure/|(^|/)presentation/|(^|/)packages/media-core/|(^|/)packages/tool-sdk/|node_modules/(@nestjs/|next/|react/|react-dom/|express/|bullmq/|typeorm/)",
    },
  },
  {
    name: "presentation-no-infrastructure",
    severity: "error",
    comment:
      "Presentation does not construct adapters. Folders named presentation and the Next.js App Router tree apps/web/src/app are presentation.",
    from: {
      path: "(^|/)presentation/|(^|/)apps/web/src/app/",
      pathNot: "node_modules",
    },
    to: { path: "(^|/)infrastructure/", pathNot: "node_modules" },
  },
  {
    name: "infrastructure-no-presentation",
    severity: "error",
    comment: "Adapters do not depend on delivery.",
    from: { path: "(^|/)infrastructure/", pathNot: "node_modules" },
    to: { path: "(^|/)presentation/" },
  },
  {
    name: "packages-no-deployables",
    severity: "error",
    comment: "Libraries do not depend on apps or workers.",
    from: { path: "(^|/)packages/", pathNot: "node_modules" },
    to: { path: "(^|/)(apps|workers)/", pathNot: "node_modules" },
  },
  {
    name: "leaf-schemas",
    severity: "error",
    comment: "JSON Schema package is a leaf.",
    from: { path: "^packages/schemas/" },
    to: { path: "^(apps|workers|packages)/", pathNot: "^packages/schemas/" },
  },
  {
    name: "leaf-shared",
    severity: "error",
    comment: "Shared utilities are a leaf.",
    from: { path: "^packages/shared/" },
    to: { path: "^(apps|workers|packages)/", pathNot: "^packages/shared/" },
  },
  {
    name: "tool-sdk-allow-list",
    severity: "error",
    comment: "tool-sdk may depend on domain, schemas, and shared.",
    from: { path: "^packages/tool-sdk/" },
    to: {
      pathNot:
        "^(packages/tool-sdk/|packages/domain/|packages/schemas/|packages/shared/|node_modules/)",
      dependencyTypesNot: ["core"],
    },
  },
  {
    name: "media-core-allow-list",
    severity: "error",
    comment: "media-core may depend on domain, schemas, and shared.",
    from: { path: "^packages/media-core/" },
    to: {
      pathNot:
        "^(packages/media-core/|packages/domain/|packages/schemas/|packages/shared/|node_modules/)",
      dependencyTypesNot: ["core"],
    },
  },
  {
    name: "web-allow-list",
    severity: "error",
    comment: "Web is a presentation client of schemas and shared.",
    from: { path: "^apps/web/" },
    to: {
      pathNot: "^(apps/web/|packages/schemas/|packages/shared/|node_modules/)",
      dependencyTypesNot: ["core"],
    },
  },
  {
    name: "api-allow-list",
    severity: "error",
    comment: "API may depend on domain, schemas, and shared.",
    from: { path: "^apps/api/" },
    to: {
      pathNot: "^(apps/api/|packages/domain/|packages/schemas/|packages/shared/|node_modules/)",
      dependencyTypesNot: ["core"],
    },
  },
  {
    name: "agent-worker-allow-list",
    severity: "error",
    comment: "Agent worker may depend on domain, schemas, tool-sdk, and shared.",
    from: { path: "^workers/agent-worker/" },
    to: {
      pathNot:
        "^(workers/agent-worker/|packages/domain/|packages/schemas/|packages/tool-sdk/|packages/shared/|node_modules/)",
      dependencyTypesNot: ["core"],
    },
  },
  {
    name: "media-worker-allow-list",
    severity: "error",
    comment: "Media worker may depend on domain, schemas, tool-sdk, media-core, and shared.",
    from: { path: "^workers/media-worker/" },
    to: {
      pathNot:
        "^(workers/media-worker/|packages/domain/|packages/schemas/|packages/tool-sdk/|packages/media-core/|packages/shared/|node_modules/)",
      dependencyTypesNot: ["core"],
    },
  },
  {
    name: "render-worker-allow-list",
    severity: "error",
    comment: "Render worker may depend on domain, schemas, media-core, and shared.",
    from: { path: "^workers/render-worker/" },
    to: {
      pathNot:
        "^(workers/render-worker/|packages/domain/|packages/schemas/|packages/media-core/|packages/shared/|node_modules/)",
      dependencyTypesNot: ["core"],
    },
  },
  {
    name: "workers-no-apps",
    severity: "error",
    comment: "Workers do not depend on the web or API processes.",
    from: { path: "(^|/)workers/", pathNot: "node_modules" },
    to: { path: "(^|/)apps/", pathNot: "node_modules" },
  },
  {
    name: "no-unresolved",
    severity: "error",
    comment:
      "Production source under apps, packages, and workers must not depend on a module the checker cannot resolve. An unresolved import of a framework is a violation even when that package is not installed. Architecture fixtures live outside this graph and are excluded by the production cruise.",
    from: {
      path: "(^|/)(apps|packages|workers)/",
      pathNot: "node_modules",
    },
    to: { couldNotResolve: true },
  },
  {
    name: "no-circular",
    severity: "error",
    comment: "Production source has no dependency cycles.",
    from: { pathNot: ["\\.test\\.ts$", "node_modules"] },
    to: { circular: true },
  },
];

module.exports = { forbidden };
