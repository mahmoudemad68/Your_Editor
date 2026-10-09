import { writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import prettier from "prettier";

export async function jsonBytes(value) {
  return await prettier.format(JSON.stringify(value), { parser: "json", printWidth: 100 });
}
export async function writeJson(path, value) {
  const bytes = await jsonBytes(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, bytes, { flag: "wx" });
  renameSync(temporary, path);
  return bytes;
}
