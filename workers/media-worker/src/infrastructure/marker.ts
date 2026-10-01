import { mediaCorePackageName } from "@editagent/media-core";

/** Adapter-layer marker. FFprobe is invoked by inspect.ts, not by the idle process. */
export const mediaAdapterPackage = mediaCorePackageName;
