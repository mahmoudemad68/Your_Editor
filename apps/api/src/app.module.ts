import { MultipartUploads } from "./application/multipart-uploads.js";
import { MultipartController } from "./presentation/multipart.controller.js";
import type { UploadSessionRepository } from "@editagent/domain";
import { GetCurrentUser } from "./application/current-user.js";
import { type DynamicModule, Module } from "@nestjs/common";
import {
  type IObjectStorage,
  type MediaAssetRepository,
  type ProjectRepository,
} from "@editagent/domain";
import {
  type Clock,
  type MediaAssetIdGenerator,
  type ProjectIdGenerator,
} from "./application/clock.js";
import {
  CreateProject,
  DeleteProject,
  ListProjects,
  RenameProject,
} from "./application/projects.js";
import { GetMediaDetails } from "./application/media-details.js";
import { type ReadinessProbe } from "./application/health.js";
import {
  BeginMediaUpload,
  CompleteMediaUpload,
  type UploadPublication,
} from "./application/uploads.js";
import { createServiceLogger, type JsonLogger } from "@editagent/shared";
import { ApiRequestLog } from "./presentation/api-request-log.js";
import {
  HealthController,
  READINESS_PROBE,
  ReadyController,
} from "./presentation/health.controller.js";
import { MediaController } from "./presentation/media.controller.js";
import { ProjectsController } from "./presentation/projects.controller.js";
import { UploadsController } from "./presentation/uploads.controller.js";
import {
  AUTH_COOKIE_SECURE,
  AUTH_NOW,
  AUTH_TRUSTED_PROXIES,
  AuthController,
} from "./presentation/auth.controller.js";
import { AUTH_TRUSTED_ORIGINS, LoginOriginGuard } from "./presentation/login-origin.js";
import {
  LoginUser,
  LogoutUser,
  RefreshAccess,
  RegisterUser,
} from "./application/authentication.js";
import { type SessionTokens } from "./application/session-tokens.js";

export interface ApiComposition {
  readonly projects: ProjectRepository;
  readonly clock: Clock;
  readonly ids: ProjectIdGenerator;
  readonly media: MediaAssetRepository;
  readonly objects: IObjectStorage;
  readonly mediaIds: MediaAssetIdGenerator;
  readonly presignTtlSeconds: number;
  readonly uploadSessions?: UploadSessionRepository;
  readonly logger?: JsonLogger;
  readonly publication?: UploadPublication;
  readonly readiness?: ReadinessProbe;
  readonly auth?: {
    readonly currentUser: GetCurrentUser;
    readonly register: RegisterUser;
    readonly login: LoginUser;
    readonly refresh: RefreshAccess;
    readonly logout: LogoutUser;
    readonly tokens: SessionTokens;
    readonly now: () => bigint;
    readonly cookieSecure: boolean;
    readonly trustedOrigins: readonly string[];
    readonly trustedProxies: readonly string[];
  };
}

function createFallbackLogger(): JsonLogger {
  return createServiceLogger("api");
}

/** Composition root. It wires use cases to a repository. It does not contain Project rules. */
@Module({})
export class AppModule {
  static register(composition: ApiComposition): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        ReadyController,
        ProjectsController,
        UploadsController,
        MediaController,
        ...(composition.uploadSessions === undefined ? [] : [MultipartController]),
        ...(composition.auth === undefined ? [] : [AuthController]),
      ],
      providers: [
        ...(composition.uploadSessions === undefined
          ? []
          : [
              {
                provide: MultipartUploads,
                useValue: new MultipartUploads(
                  composition.projects,
                  composition.uploadSessions,
                  composition.objects,
                  composition.media,
                  composition.mediaIds,
                  composition.clock,
                  composition.presignTtlSeconds,
                  composition.publication,
                ),
              },
            ]),
        ...(composition.auth === undefined
          ? []
          : [
              { provide: GetCurrentUser, useValue: composition.auth.currentUser },
              { provide: RegisterUser, useValue: composition.auth.register },
              { provide: LoginUser, useValue: composition.auth.login },
              { provide: RefreshAccess, useValue: composition.auth.refresh },
              { provide: LogoutUser, useValue: composition.auth.logout },
              { provide: AUTH_NOW, useValue: composition.auth.now },
              { provide: AUTH_COOKIE_SECURE, useValue: composition.auth.cookieSecure },
              { provide: AUTH_TRUSTED_PROXIES, useValue: composition.auth.trustedProxies },
              { provide: AUTH_TRUSTED_ORIGINS, useValue: composition.auth.trustedOrigins },
              LoginOriginGuard,
            ]),
        {
          provide: CreateProject,
          useValue: new CreateProject(composition.projects, composition.ids, composition.clock),
        },
        {
          provide: RenameProject,
          useValue: new RenameProject(composition.projects, composition.clock),
        },
        {
          provide: ListProjects,
          useValue: new ListProjects(composition.projects),
        },
        {
          provide: DeleteProject,
          useValue: new DeleteProject(composition.projects, composition.clock),
        },
        {
          provide: BeginMediaUpload,
          useValue: new BeginMediaUpload(
            composition.projects,
            composition.objects,
            composition.clock,
            composition.presignTtlSeconds,
          ),
        },
        {
          provide: GetMediaDetails,
          useValue: new GetMediaDetails(composition.projects, composition.media),
        },
        {
          provide: READINESS_PROBE,
          useValue: composition.readiness ?? {
            async check(): Promise<boolean> {
              return false;
            },
          },
        },
        {
          provide: ApiRequestLog,
          useValue: new ApiRequestLog(composition.logger ?? createFallbackLogger()),
        },
        {
          provide: CompleteMediaUpload,
          useValue: composition.publication
            ? new CompleteMediaUpload(
                composition.projects,
                composition.media,
                composition.objects,
                composition.mediaIds,
                composition.clock,
                composition.publication,
              )
            : new CompleteMediaUpload(
                composition.projects,
                composition.media,
                composition.objects,
                composition.mediaIds,
                composition.clock,
              ),
        },
      ],
    };
  }
}
