import { DocumentBuilder } from "@nestjs/swagger";

export function createOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle("EditAgent API")
    .setDescription(
      "Cookie-authenticated sessions, project operations, and persisted media metadata.",
    )
    .setVersion("0.0.0")
    .build();
}
