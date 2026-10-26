import { mkdirSync, copyFileSync, readdirSync, lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import { loadPromptDirectory } from "./prompts.js";
// Build-time source directory is fixed, never caller supplied. No downloads.
const source = path.resolve(__dirname, "../../../prompts"),
  target = path.join(__dirname, "prompts");
loadPromptDirectory(source);
mkdirSync(target, { recursive: true });
if (lstatSync(target).isSymbolicLink()) throw new Error("Invalid prompt bundle directory");
for (const file of readdirSync(target)) {
  if (
    !/^[a-z][a-z0-9_-]{0,47}@[0-9]+\.[0-9]+\.[0-9]+\.prompt$/.test(file) ||
    !lstatSync(path.join(target, file)).isFile()
  )
    throw new Error("Invalid existing prompt bundle");
  unlinkSync(path.join(target, file));
}
for (const file of readdirSync(source).sort())
  copyFileSync(path.join(source, file), path.join(target, file));
loadPromptDirectory(target);
