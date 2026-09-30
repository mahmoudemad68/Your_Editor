import { DocumentBuilder } from "@nestjs/swagger";

export function createOpenApiConfig() {
  return new DocumentBuilder()
    .setTitle("EditAgent API")
    .setDescription(
      "Project create, list, rename, and soft delete. Sign-in is US-118 and is not issued here.",
    )
    .setVersion("0.0.0")
    .build();
}
