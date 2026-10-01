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
import { BeginMediaUpload, CompleteMediaUpload } from "./application/uploads.js";
import { HealthController } from "./presentation/health.controller.js";
import { MediaController } from "./presentation/media.controller.js";
import { ProjectsController } from "./presentation/projects.controller.js";
import { UploadsController } from "./presentation/uploads.controller.js";

export interface ApiComposition {
  readonly projects: ProjectRepository;
  readonly clock: Clock;
  readonly ids: ProjectIdGenerator;
  readonly media: MediaAssetRepository;
  readonly objects: IObjectStorage;
  readonly mediaIds: MediaAssetIdGenerator;
  readonly presignTtlSeconds: number;
}

/** Composition root. It wires use cases to a repository. It does not contain Project rules. */
@Module({})
export class AppModule {
  static register(composition: ApiComposition): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ProjectsController, UploadsController, MediaController],
      providers: [
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
          provide: CompleteMediaUpload,
          useValue: new CompleteMediaUpload(
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
