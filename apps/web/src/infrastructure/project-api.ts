import { CORRELATION_HEADER } from "@editagent/shared";

import { createGeneratedClient } from "../generated/client";
import type { ApiResult, ProjectApi, RequestOptions, UploadDeclaration } from "../project-contract";

export interface ProjectApiOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly correlationId?: string;
  readonly requestHeaders?: Headers;
}

/**
 * HTTP adapter for the generated OpenAPI client.
 * It does not add an actor header, a user id, or a development token.
 * The composition root forwards the incoming cookie and explicit CSRF header.
 */
export function createHttpProjectApi(options: ProjectApiOptions): ProjectApi {
  const baseFetch = options.fetchImpl ?? fetch;
  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    options.requestHeaders?.forEach((value, key) => headers.set(key, value));
    if (options.correlationId !== undefined) headers.set(CORRELATION_HEADER, options.correlationId);
    return baseFetch(input, { ...init, headers, cache: "no-store", redirect: "error" });
  };
  const client = createGeneratedClient(options.baseUrl, fetchImpl);
  return {
    async listProjects() {
      try {
        const result = await client.GET("/projects");
        if (result.response.ok && result.data !== undefined) {
          return { ok: true, data: result.data.projects };
        }
        return failureResult(result.response, result.error);
      } catch {
        return unreachable();
      }
    },
    async createProject(name: string) {
      try {
        const result = await client.POST("/projects", { body: { name } });
        if (result.response.ok && result.data !== undefined) {
          return { ok: true, data: result.data };
        }
        return failureResult(result.response, result.error);
      } catch {
        return unreachable();
      }
    },
    async renameProject(projectId: string, name: string) {
      try {
        const result = await client.PATCH("/projects/{projectId}", {
          params: { path: { projectId } },
          body: { name },
        });
        if (result.response.ok && result.data !== undefined) {
          return { ok: true, data: result.data };
        }
        return failureResult(result.response, result.error);
      } catch {
        return unreachable();
      }
    },
    async deleteProject(projectId: string) {
      try {
        const result = await client.DELETE("/projects/{projectId}", {
          params: { path: { projectId } },
        });
        if (result.response.status === 204) {
          return { ok: true, data: undefined };
        }
        return failureResult(result.response, result.error);
      } catch {
        return unreachable();
      }
    },
    async beginUpload(projectId: string, body: UploadDeclaration, options?: RequestOptions) {
      try {
        const result = await client.POST("/projects/{projectId}/uploads", {
          params: { path: { projectId } },
          body,
          signal: options?.signal,
        });
        if (result.response.ok && result.data !== undefined) {
          return { ok: true, data: result.data };
        }
        return failureResult(result.response, result.error);
      } catch {
        return unreachable();
      }
    },
    async completeUpload(projectId: string, body: UploadDeclaration, options?: RequestOptions) {
      try {
        const result = await client.POST("/projects/{projectId}/uploads/complete", {
          params: { path: { projectId } },
          body,
          signal: options?.signal,
        });
        if (result.response.ok && result.data !== undefined) {
          return { ok: true, data: result.data };
        }
        return failureResult(result.response, result.error);
      } catch {
        return unreachable();
      }
    },
    async getMediaDetails(projectId: string, mediaAssetId: string, options?: RequestOptions) {
      try {
        const result = await client.GET("/projects/{projectId}/media/{mediaAssetId}", {
          params: { path: { projectId, mediaAssetId } },
          signal: options?.signal,
        });
        if (result.response.ok && result.data !== undefined) {
          return { ok: true, data: result.data };
        }
        return failureResult(result.response, result.error);
      } catch {
        return unreachable();
      }
    },
  };
}

function failureResult(response: Response, error: unknown): ApiResult<never> {
  if (response.status === 401) {
    return { ok: false, status: 401, message: "Sign in is required." };
  }
  if (response.status >= 500) {
    const message = readMessage(error);
    if (message === "Object storage is unavailable.") {
      return { ok: false, status: response.status, message };
    }
    return { ok: false, status: response.status, message: "The Project service is unavailable." };
  }
  const message = readMessage(error);
  if (message !== null && message.length <= 200 && !message.includes("\n")) {
    return { ok: false, status: response.status, message };
  }
  return { ok: false, status: response.status, message: "The request was not completed." };
}

function readMessage(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("message" in body)) {
    return null;
  }
  const message = body.message;
  if (typeof message === "string") {
    return message.trim();
  }
  if (Array.isArray(message) && typeof message[0] === "string") {
    return message[0].trim();
  }
  return null;
}

function unreachable(): ApiResult<never> {
  return { ok: false, status: 0, message: "The Project service could not be reached." };
}
