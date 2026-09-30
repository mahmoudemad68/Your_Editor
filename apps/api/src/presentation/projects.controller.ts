import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { DomainError, projectId, type ProjectId } from "@editagent/domain";
import {
  CreateProject,
  DeleteProject,
  ListProjects,
  RenameProject,
} from "../application/projects.js";
import { requireActor } from "./actor.js";
import {
  CreateProjectBody,
  ProjectListResponseDto,
  ProjectResponseDto,
  RenameProjectBody,
  toProjectResponse,
} from "./project.dto.js";

@ApiTags("projects")
@Controller("projects")
export class ProjectsController {
  constructor(
    private readonly createProject: CreateProject,
    private readonly listProjects: ListProjects,
    private readonly renameProject: RenameProject,
    private readonly deleteProject: DeleteProject,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: "Create a Project. The caller becomes its Owner." })
  @ApiCreatedResponse({ type: ProjectResponseDto })
  @ApiBadRequestResponse({ description: "The Project name is missing or blank." })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  @ApiConflictResponse({ description: "The Project changed since it was loaded." })
  async create(
    @Body() body: CreateProjectBody,
    @Req() request: object,
  ): Promise<ProjectResponseDto> {
    const actorUserId = requireActor(request);
    const project = await this.createProject.execute(actorUserId, body.name);
    return toProjectResponse(project, actorUserId);
  }

  @Get()
  @ApiOperation({ summary: "List Projects the caller belongs to." })
  @ApiOkResponse({ type: ProjectListResponseDto })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  async list(@Req() request: object): Promise<ProjectListResponseDto> {
    const actorUserId = requireActor(request);
    const projects = await this.listProjects.execute(actorUserId);
    return { projects: projects.map((project) => toProjectResponse(project, actorUserId)) };
  }

  @Patch(":projectId")
  @ApiOperation({ summary: "Rename a Project." })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiBadRequestResponse({ description: "The id or the name is not valid." })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  @ApiForbiddenResponse({ description: "Only an Owner or Editor can rename a Project." })
  @ApiNotFoundResponse({ description: "The Project is not visible to the caller." })
  @ApiConflictResponse({ description: "The Project changed since it was loaded." })
  async rename(
    @Param("projectId") rawProjectId: string,
    @Body() body: RenameProjectBody,
    @Req() request: object,
  ): Promise<ProjectResponseDto> {
    const actorUserId = requireActor(request);
    const project = await this.renameProject.execute(
      actorUserId,
      parseProjectRouteId(rawProjectId),
      body.name,
    );
    return toProjectResponse(project, actorUserId);
  }

  @Delete(":projectId")
  @HttpCode(204)
  @ApiOperation({ summary: "Soft-delete a Project. Only an Owner may delete." })
  @ApiNoContentResponse()
  @ApiBadRequestResponse({ description: "The id is not a UUIDv7." })
  @ApiUnauthorizedResponse({ description: "Sign in is required." })
  @ApiForbiddenResponse({ description: "Only an Owner can delete a Project." })
  @ApiNotFoundResponse({ description: "The Project is not visible to the caller." })
  @ApiConflictResponse({ description: "The Project changed since it was loaded." })
  async remove(@Param("projectId") rawProjectId: string, @Req() request: object): Promise<void> {
    await this.deleteProject.execute(requireActor(request), parseProjectRouteId(rawProjectId));
  }
}

function parseProjectRouteId(value: string): ProjectId {
  try {
    return projectId(value);
  } catch (error) {
    if (error instanceof DomainError) {
      throw new BadRequestException("projectId must be a UUIDv7.");
    }
    throw error;
  }
}
