import { Controller, Get } from "@nestjs/common";
import { getHealthStatus, type HealthStatus } from "../application/health.js";

@Controller("health")
export class HealthController {
  @Get()
  health(): HealthStatus {
    return getHealthStatus();
  }
}
