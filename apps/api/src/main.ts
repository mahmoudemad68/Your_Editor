import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";

export async function bootstrap(port = process.env["PORT"] ?? "3001"): Promise<void> {
  const app = await NestFactory.create(AppModule);
  await app.listen(port);
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
