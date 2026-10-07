import assert from "node:assert/strict";
import { test } from "vitest";
import { AgentRun, CreativeMemory } from "./modules/agent/agent-run.js";
import { Component } from "./modules/components/component.js";
import { Critique } from "./modules/critic/critique.js";
import { Clip, Effect, Timeline, Track } from "./modules/editing/timeline.js";
import { MediaAsset } from "./modules/media/media-asset.js";
import { BrandKit } from "./modules/projects/brand-kit.js";
import { Project } from "./modules/projects/project.js";
import { Tool } from "./modules/tools/tool.js";

test("US-102 canonical names are the domain class names", () => {
  const names = [
    MediaAsset,
    Project,
    Timeline,
    Track,
    Clip,
    Effect,
    Tool,
    Component,
    AgentRun,
    Critique,
    BrandKit,
    CreativeMemory,
  ].map((domainClass) => domainClass.name);
  assert.deepEqual(names, [
    "MediaAsset",
    "Project",
    "Timeline",
    "Track",
    "Clip",
    "Effect",
    "Tool",
    "Component",
    "AgentRun",
    "Critique",
    "BrandKit",
    "CreativeMemory",
  ]);
});
