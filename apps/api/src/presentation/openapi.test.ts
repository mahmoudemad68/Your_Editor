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
  for (const status of ["201", "400", "401", "409"]) {
    assert.ok(collection?.post?.responses?.[status], `POST /projects ${status}`);
  }
  assert.ok(collection?.get?.responses?.["200"]);
  for (const status of ["200", "400", "401", "403", "404", "409"]) {
    assert.ok(item?.patch?.responses?.[status], `PATCH /projects/{projectId} ${status}`);
  }
  for (const status of ["204", "400", "401", "403", "404", "409"]) {
    assert.ok(item?.delete?.responses?.[status], `DELETE /projects/{projectId} ${status}`);
  }
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
    assert.equal(projectSchema.properties["revision"], undefined);
    assert.equal(projectSchema.properties["passwordHash"], undefined);
  }
});
