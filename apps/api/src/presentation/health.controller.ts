import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import {
  getHealthStatus,
  getReadyStatus,
  type HealthStatus,
  type ReadyStatus,
} from "../application/health.js";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  @ApiOkResponse({ description: "The process is alive." })
  health(): HealthStatus {
    return getHealthStatus();
  }
}

@ApiTags("health")
@Controller("ready")
export class ReadyController {
  @Get()
  @ApiOkResponse({ description: "The process can accept work." })
  ready(): ReadyStatus {
    return getReadyStatus();
  }
}
