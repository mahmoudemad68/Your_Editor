import { Controller, Get, HttpException, HttpStatus, Inject } from "@nestjs/common";
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from "@nestjs/swagger";
import {
  getHealthStatus,
  getReadyStatus,
  type HealthStatus,
  type ReadinessProbe,
  type ReadyStatus,
} from "../application/health.js";

export const READINESS_PROBE = "READINESS_PROBE";

@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  @ApiOkResponse({ description: "The process is alive. This does not check dependencies." })
  health(): HealthStatus {
    return getHealthStatus();
  }
}

@ApiTags("health")
@Controller("ready")
export class ReadyController {
  constructor(@Inject(READINESS_PROBE) private readonly probe: ReadinessProbe) {}

  @Get()
  @ApiOkResponse({ description: "Postgres and Redis accepted a readiness check." })
  @ApiServiceUnavailableResponse({ description: "A required dependency did not answer." })
  async ready(): Promise<ReadyStatus> {
    if (!(await this.probe.check())) {
      throw new HttpException(getReadyStatus(false), HttpStatus.SERVICE_UNAVAILABLE);
    }
    return getReadyStatus(true);
  }
}
