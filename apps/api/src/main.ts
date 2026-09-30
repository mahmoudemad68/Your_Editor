import "reflect-metadata";
import { Pool } from "pg";
import { createApiApplication } from "./create-api-application.js";
import { ConfigurationError, loadApiConfig } from "./infrastructure/config.js";
import { applyMigrations } from "./infrastructure/migrate.js";
import { NodeProjectIdGenerator } from "./infrastructure/node-project-id-generator.js";
import { PostgresProjectRepository } from "./infrastructure/postgres-project-repository.js";
import { SystemClock } from "./infrastructure/system-clock.js";

export async function bootstrap(): Promise<void> {
  const config = loadApiConfig();
  const pool = new Pool({ connectionString: config.databaseUrl });
  await applyMigrations(pool);
  const app = await createApiApplication({
    projects: new PostgresProjectRepository(pool),
    clock: new SystemClock(),
    ids: new NodeProjectIdGenerator(),
  });
  await app.listen(config.port, config.host);
}

if (require.main === module) {
  bootstrap().catch((error: unknown) => {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`${error.message}\n`);
    } else if (error instanceof Error) {
      process.stderr.write(`${error.stack ?? error.message}\n`);
    } else {
      process.stderr.write(`${String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
