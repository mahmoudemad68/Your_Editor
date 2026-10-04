import { z } from "zod";

export type EnvSource = {
  readonly [key: string]: string | undefined;
};

export class ConfigurationError extends Error {
  readonly processName: string;

  constructor(processName: string, message: string) {
    super(message);
    this.name = "ConfigurationError";
    this.processName = processName;
  }
}

export interface ApiObjectStorageConfig {
  readonly endpoint: string;
  readonly publicEndpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  readonly presignTtlSeconds: number;
}

export interface ApiConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly port: number;
  readonly host: string;
  readonly authJwtSecret: string;
  readonly authCookieSecure: boolean;
  readonly objectStorage: ApiObjectStorageConfig;
}

export interface WebConfig {
  readonly apiBaseUrl: string;
  readonly port: number;
}

export interface AgentWorkerConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly llmApiKey?: string;
  readonly llmBaseUrl?: string;
  readonly llmProvider?: string;
}

export interface ObjectStorageConfig {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export interface StorageWorkerConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly objectStorage: ObjectStorageConfig;
}

const requiredMessage = (name: string, hint: string): string => `${name} is required. ${hint}`;

function requiredString(name: string, hint: string) {
  const message = requiredMessage(name, hint);
  return z
    .string({
      error: (issue) => (issue.input === undefined ? message : `${name} must be a string.`),
    })
    .min(1, { error: message });
}

function urlWithSchemes(name: string, schemes: readonly string[], hint: string) {
  const allowed = schemes.join(" or ");
  return requiredString(name, hint).refine(
    (value) => {
      try {
        const url = new URL(value);
        return schemes.includes(url.protocol) && url.hostname.length > 0;
      } catch {
        return false;
      }
    },
    { error: `${name} must be a valid ${allowed} URL with a host.` },
  );
}

const databaseUrl = () =>
  urlWithSchemes(
    "DATABASE_URL",
    ["postgres:", "postgresql:"],
    "Set it to a postgresql:// connection URL. The service cannot start without a database URL.",
  );

const redisUrl = () =>
  urlWithSchemes("REDIS_URL", ["redis:", "rediss:"], "Set it to a redis:// URL.");

const httpUrl = (name: string, hint: string) => urlWithSchemes(name, ["http:", "https:"], hint);

function portField(defaultPort: number) {
  return z
    .string()
    .optional()
    .refine(
      (value) => {
        if (value === undefined) {
          return true;
        }
        if (!/^[0-9]+$/.test(value)) {
          return false;
        }
        const parsed = Number(value);
        return parsed >= 1 && parsed <= 65535;
      },
      { error: "PORT must be an integer from 1 to 65535." },
    )
    .transform((value) => (value === undefined ? defaultPort : Number(value)));
}

function hostField() {
  return z
    .string()
    .optional()
    .refine((value) => value === undefined || value.trim().length > 0, {
      error: "HOST is set but empty. Remove it or provide a bind address.",
    })
    .transform((value) => (value === undefined ? "0.0.0.0" : value));
}

function optionalNonEmpty(name: string) {
  return z
    .string()
    .optional()
    .refine((value) => value === undefined || value.trim().length > 0, {
      error: `${name} is set but empty. Remove it or provide a non-empty value. Do not commit a real provider key.`,
    });
}

function optionalHttpUrl(name: string) {
  return optionalNonEmpty(name).refine(
    (value) => {
      if (value === undefined) {
        return true;
      }
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0;
      } catch {
        return false;
      }
    },
    { error: `${name} must be an http:// or https:// URL when it is set.` },
  );
}

function optionalProviderName(name: string) {
  return optionalNonEmpty(name).refine(
    (value) => value === undefined || /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value),
    { error: `${name} must be a short provider id such as openai, ollama, or vllm.` },
  );
}

function presignTtlSeconds() {
  return z
    .string()
    .optional()
    .refine(
      (value) => {
        if (value === undefined) {
          return true;
        }
        if (!/^[1-9][0-9]*$/.test(value)) {
          return false;
        }
        const parsed = Number(value);
        return parsed >= 60 && parsed <= 3600;
      },
      { error: "S3_PRESIGN_TTL_SECONDS must be an integer from 60 through 3600." },
    )
    .transform((value) => (value === undefined ? 900 : Number(value)));
}

const apiSchema = z
  .object({
    DATABASE_URL: databaseUrl(),
    REDIS_URL: redisUrl(),
    PORT: portField(3001),
    HOST: hostField(),
    S3_ENDPOINT: httpUrl(
      "S3_ENDPOINT",
      "Set it to the S3-compatible endpoint the API uses, for example http://minio:9000.",
    ),
    S3_PUBLIC_ENDPOINT: httpUrl(
      "S3_PUBLIC_ENDPOINT",
      "Set it to the S3 endpoint the browser can reach, for example http://localhost:9000.",
    ),
    S3_BUCKET: requiredString("S3_BUCKET", "Set it to the private media bucket name."),
    S3_ACCESS_KEY_ID: requiredString(
      "S3_ACCESS_KEY_ID",
      "Set it to the object-storage access key. It stays on the API.",
    ),
    S3_SECRET_ACCESS_KEY: requiredString(
      "S3_SECRET_ACCESS_KEY",
      "Set it to the object-storage secret key. It stays on the API.",
    ),
    S3_REGION: requiredString(
      "S3_REGION",
      "Set it to the object-storage region, for example us-east-1.",
    ),
    S3_PRESIGN_TTL_SECONDS: presignTtlSeconds(),
    AUTH_JWT_SECRET: requiredString(
      "AUTH_JWT_SECRET",
      "Set it to a random signing secret of at least 32 characters. Do not reuse a password.",
    ).refine((value) => value.length >= 32, {
      error: "AUTH_JWT_SECRET must be at least 32 characters.",
    }),
    AUTH_COOKIE_SECURE: z.string().optional(),
    EDITAGENT_RUNTIME: z.string().optional(),
  })
  .superRefine((env, context) => {
    const runtime = env.EDITAGENT_RUNTIME ?? "development";
    if (runtime !== "development" && runtime !== "staging" && runtime !== "production") {
      context.addIssue({
        code: "custom",
        path: ["EDITAGENT_RUNTIME"],
        message: "EDITAGENT_RUNTIME must be development, staging, or production.",
      });
    }
    const secure = env.AUTH_COOKIE_SECURE === undefined ? true : env.AUTH_COOKIE_SECURE === "true";
    if ((runtime === "staging" || runtime === "production") && !secure) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_COOKIE_SECURE"],
        message:
          "AUTH_COOKIE_SECURE must be true when EDITAGENT_RUNTIME is staging or production. Staging cannot send authentication cookies without the Secure attribute.",
      });
    }
  })
  .transform((env): ApiConfig => ({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    port: env.PORT,
    host: env.HOST,
    authJwtSecret: env.AUTH_JWT_SECRET,
    authCookieSecure:
      env.AUTH_COOKIE_SECURE === undefined ? true : env.AUTH_COOKIE_SECURE === "true",
    objectStorage: {
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION,
      presignTtlSeconds: env.S3_PRESIGN_TTL_SECONDS,
    },
  }));

const webSchema = z
  .object({
    API_BASE_URL: httpUrl(
      "API_BASE_URL",
      "Set it to the API base URL, for example http://api:3001.",
    ),
    PORT: portField(3000),
  })
  .transform((env): WebConfig => ({
    apiBaseUrl: env.API_BASE_URL,
    port: env.PORT,
  }));

const agentSchema = z
  .object({
    DATABASE_URL: databaseUrl(),
    REDIS_URL: redisUrl(),
    LLM_API_KEY: optionalNonEmpty("LLM_API_KEY"),
    LLM_BASE_URL: optionalHttpUrl("LLM_BASE_URL"),
    LLM_PROVIDER: optionalProviderName("LLM_PROVIDER"),
  })
  .transform((env): AgentWorkerConfig => {
    const config: {
      databaseUrl: string;
      redisUrl: string;
      llmApiKey?: string;
      llmBaseUrl?: string;
      llmProvider?: string;
    } = {
      databaseUrl: env.DATABASE_URL,
      redisUrl: env.REDIS_URL,
    };
    if (env.LLM_API_KEY !== undefined) {
      config.llmApiKey = env.LLM_API_KEY;
    }
    if (env.LLM_BASE_URL !== undefined) {
      config.llmBaseUrl = env.LLM_BASE_URL;
    }
    if (env.LLM_PROVIDER !== undefined) {
      config.llmProvider = env.LLM_PROVIDER;
    }
    return config;
  });

const storageWorkerSchema = z
  .object({
    DATABASE_URL: databaseUrl(),
    REDIS_URL: redisUrl(),
    S3_ENDPOINT: httpUrl(
      "S3_ENDPOINT",
      "Set it to the S3-compatible endpoint, for example http://minio:9000.",
    ),
    S3_BUCKET: requiredString("S3_BUCKET", "Set it to the development bucket name."),
    S3_ACCESS_KEY_ID: requiredString(
      "S3_ACCESS_KEY_ID",
      "Set it to the development object-storage access key.",
    ),
    S3_SECRET_ACCESS_KEY: requiredString(
      "S3_SECRET_ACCESS_KEY",
      "Set it to the development object-storage secret key.",
    ),
    S3_REGION: requiredString(
      "S3_REGION",
      "Set it to the development region, for example us-east-1.",
    ),
  })
  .transform((env): StorageWorkerConfig => ({
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    objectStorage: {
      endpoint: env.S3_ENDPOINT,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      region: env.S3_REGION,
    },
  }));

function parseProcessEnv<T>(processName: string, schema: z.ZodType<T>, env: EnvSource): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "environment";
      return `- ${field}: ${issue.message}`;
    });
    throw new ConfigurationError(
      processName,
      `${processName} configuration error. Fix the environment and restart.\n${lines.join("\n")}`,
    );
  }
  return result.data;
}

export function parseApiConfig(env: EnvSource): ApiConfig {
  return parseProcessEnv("API", apiSchema, env);
}

export function parseWebConfig(env: EnvSource): WebConfig {
  return parseProcessEnv("Web", webSchema, env);
}

export function parseAgentWorkerConfig(env: EnvSource): AgentWorkerConfig {
  return parseProcessEnv("Agent worker", agentSchema, env);
}

export function parseMediaWorkerConfig(env: EnvSource): StorageWorkerConfig {
  return parseProcessEnv("Media worker", storageWorkerSchema, env);
}

export function parseRenderWorkerConfig(env: EnvSource): StorageWorkerConfig {
  return parseProcessEnv("Render worker", storageWorkerSchema, env);
}
