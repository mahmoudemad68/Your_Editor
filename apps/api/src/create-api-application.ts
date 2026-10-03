import "reflect-metadata";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { SwaggerModule } from "@nestjs/swagger";
import { createServiceLogger, startNoopTracing, type JsonLogger } from "@editagent/shared";
import { AppModule, type ApiComposition } from "./app.module.js";
import { bindRequestCorrelation } from "./presentation/correlation.js";
import { createOpenApiConfig } from "./presentation/openapi.js";
import { ProjectExceptionFilter } from "./presentation/project-exception.filter.js";

type RequestHandler = (request: object, response: unknown, next: () => void) => void;

/** Builds the HTTP application from an already constructed repository and clock. */
export async function createApiApplication(
  composition: ApiComposition,
  beforeRoutes?: (use: (handler: RequestHandler) => void) => void,
  logger: JsonLogger = createServiceLogger("api"),
): Promise<INestApplication> {
  startNoopTracing("api");
  const adapter = new ExpressAdapter();
  adapter.use(bindRequestCorrelation(logger));
  beforeRoutes?.((handler) => {
    adapter.use(handler);
  });
  const app = await NestFactory.create(AppModule.register({ ...composition, logger }), adapter, {
    logger: false,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: false,
    }),
  );
  app.useGlobalFilters(new ProjectExceptionFilter());
  return app;
}

export async function createOpenApiDocument(composition: ApiComposition) {
  const app = await createApiApplication(composition);
  try {
    return SwaggerModule.createDocument(app, createOpenApiConfig());
  } finally {
    await app.close();
  }
}
