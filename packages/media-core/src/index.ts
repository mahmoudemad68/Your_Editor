/**
 * Infrastructure adapters for FFprobe and FFmpeg.
 * Only this package spawns FFprobe. The IMediaProbe contract lives in the domain
 * Media module so application code does not import this package for the type.
 * Domain code must not import this package.
 */
export const mediaCorePackageName = "@editagent/media-core" as const;

export { FFprobeMediaProbe, buildFfprobeArgs, FFPROBE_SHOW_ENTRIES } from "./ffprobe-adapter.js";
export type { FFprobeAdapterOptions } from "./ffprobe-adapter.js";
export { mapFfprobeDocument } from "./ffprobe-json.js";
