import { type DynamicModule, Module } from "@nestjs/common";
import { type Clock, type ProjectIdGenerator } from "./application/clock.js";
import {
  CreateProject,
  DeleteProject,
  ListProjects,
  RenameProject,
} from "./application/projects.js";
import { type ProjectRepository } from "@editagent/domain";
import { HealthController } from "./presentation/health.controller.js";
import { ProjectsController } from "./presentation/projects.controller.js";

export interface ApiComposition {
  readonly projects: ProjectRepository;
  readonly clock: Clock;
  readonly ids: ProjectIdGenerator;
}

/** Composition root. It wires use cases to a repository. It does not contain Project rules. */
@Module({})
export class AppModule {
  static register(composition: ApiComposition): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ProjectsController],
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
      ],
    };
  }
}
