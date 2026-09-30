import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { type OpenAPIObject } from "@nestjs/swagger";

test("the build writes an OpenAPI document for the Project routes", () => {
  const file = path.resolve(__dirname, "../openapi.json");
  const document = JSON.parse(readFileSync(file, "utf8")) as OpenAPIObject;
  assert.equal(document.info.title, "EditAgent API");
  const collection = document.paths["/projects"];
  const item = document.paths["/projects/{projectId}"];
  assert.ok(collection?.post?.responses?.["201"]);
  assert.ok(collection?.get?.responses?.["200"]);
  assert.ok(item?.patch?.responses?.["200"]);
  assert.ok(item?.delete?.responses?.["204"]);
  const schemas = Object.values(document.components?.schemas ?? {});
  const projectSchema = schemas.find((schema) => {
    if (schema === undefined || !("properties" in schema) || schema.properties === undefined) {
      return false;
    }
    return "role" in schema.properties && "createdAt" in schema.properties;
  });
  assert.ok(projectSchema);
  if (projectSchema && "properties" in projectSchema && projectSchema.properties) {
    assert.ok(projectSchema.properties["id"]);
    assert.ok(projectSchema.properties["name"]);
    assert.ok(projectSchema.properties["updatedAt"]);
    assert.equal(projectSchema.properties["deleted_at"], undefined);
    assert.equal(projectSchema.properties["passwordHash"], undefined);
  }
});
