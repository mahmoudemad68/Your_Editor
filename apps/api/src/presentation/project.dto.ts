import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";
import { Project, type UserId } from "@editagent/domain";
import { ProjectNotFoundError } from "../application/project-access.js";

export class CreateProjectBody {
  @ApiProperty({ example: "Launch" })
  @IsString()
  name!: string;
}

export class RenameProjectBody {
  @ApiProperty({ example: "Launch cut" })
  @IsString()
  name!: string;
}

export class ProjectResponseDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ["owner", "editor", "viewer"] })
  role!: "owner" | "editor" | "viewer";

  @ApiProperty({ description: "Unix epoch milliseconds as a decimal string." })
  createdAt!: string;

  @ApiProperty({ description: "Unix epoch milliseconds as a decimal string." })
  updatedAt!: string;
}

export class ProjectListResponseDto {
  @ApiProperty({ type: [ProjectResponseDto] })
  projects!: ProjectResponseDto[];
}

export function toProjectResponse(project: Project, actorUserId: UserId): ProjectResponseDto {
  const role = project.roleOf(actorUserId);
  if (role === null) {
    throw new ProjectNotFoundError();
  }
  return {
    id: project.id,
    name: project.name,
    role,
    createdAt: project.createdAt.toString(),
    updatedAt: project.updatedAt.toString(),
  };
}
