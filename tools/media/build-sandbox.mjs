import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
const root = process.cwd();
mkdirSync(path.join(root, "dist/native"), { recursive: true });
execFileSync(
  "cc",
  [
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-fstack-protector-strong",
    "-D_FORTIFY_SOURCE=2",
    "-Wl,-z,relro,-z,now",
    path.join(root, "media-sandbox.c"),
    "-o",
    path.join(root, "dist/native/media-sandbox"),
  ],
  { stdio: "inherit" },
);
