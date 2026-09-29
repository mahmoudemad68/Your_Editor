export { frameIndex, frameRate, microseconds } from "./kernel/time.js";
export type { FrameIndex, FrameRate, Microseconds } from "./kernel/time.js";

export { agentModule } from "./modules/agent/index.js";
export { analysisModule } from "./modules/analysis/index.js";
export { assetsModule } from "./modules/assets/index.js";
export { componentsModule } from "./modules/components/index.js";
export { criticModule } from "./modules/critic/index.js";
export { editingModule } from "./modules/editing/index.js";
export { identityModule } from "./modules/identity/index.js";
export { jobsModule } from "./modules/jobs/index.js";
export { mediaModule } from "./modules/media/index.js";
export { projectsModule } from "./modules/projects/index.js";
export { renderingModule } from "./modules/rendering/index.js";
export { toolsModule } from "./modules/tools/index.js";

import { agentModule } from "./modules/agent/index.js";
import { analysisModule } from "./modules/analysis/index.js";
import { assetsModule } from "./modules/assets/index.js";
import { componentsModule } from "./modules/components/index.js";
import { criticModule } from "./modules/critic/index.js";
import { editingModule } from "./modules/editing/index.js";
import { identityModule } from "./modules/identity/index.js";
import { jobsModule } from "./modules/jobs/index.js";
import { mediaModule } from "./modules/media/index.js";
import { projectsModule } from "./modules/projects/index.js";
import { renderingModule } from "./modules/rendering/index.js";
import { toolsModule } from "./modules/tools/index.js";

/** Bounded module ids. This is the public registry of module names. */
export const boundedModules = [
  agentModule,
  analysisModule,
  assetsModule,
  componentsModule,
  criticModule,
  editingModule,
  identityModule,
  jobsModule,
  mediaModule,
  projectsModule,
  renderingModule,
  toolsModule,
] as const;
