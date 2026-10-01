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
  const uploads = document.paths["/projects/{projectId}/uploads"];
  const complete = document.paths["/projects/{projectId}/uploads/complete"];
  for (const status of ["201", "400", "401", "403", "404"]) {
    assert.ok(uploads?.post?.responses?.[status], `POST /projects/{projectId}/uploads ${status}`);
  }
  assert.equal(uploads?.post?.responses?.["502"], undefined);
  for (const status of ["201", "400", "401", "403", "404", "409", "502"]) {
    assert.ok(
      complete?.post?.responses?.[status],
      `POST /projects/{projectId}/uploads/complete ${status}`,
    );
  }
  const media = document.paths["/projects/{projectId}/media/{mediaAssetId}"];
  for (const status of ["200", "400", "401", "404"]) {
    assert.ok(media?.get?.responses?.[status], `GET media details ${status}`);
  }
  assert.equal(media?.get?.responses?.["403"], undefined);
  const mediaSchema = document.components?.schemas?.["MediaDetailsResponseDto"];
  assert.ok(mediaSchema && "properties" in mediaSchema && mediaSchema.properties);
  if (mediaSchema && "properties" in mediaSchema && mediaSchema.properties) {
    assert.ok(mediaSchema.properties["inspectionStatus"]);
    assert.ok(mediaSchema.properties["duration"]);
    assert.ok(mediaSchema.properties["displayWidth"]);
    assert.ok(mediaSchema.properties["displayHeight"]);
    assert.ok(mediaSchema.properties["frameRateNumerator"]);
    assert.ok(mediaSchema.properties["inspectionError"]);
    assert.equal(mediaSchema.properties["storageKey"], undefined);
    assert.equal(mediaSchema.properties["secretAccessKey"], undefined);
    assert.equal(mediaSchema.properties["stderr"], undefined);
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
