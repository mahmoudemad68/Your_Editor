import { instant, type Instant } from "@editagent/domain";

/** Process clock. The application Clock port is structural, so this file does not import it. */
export class SystemClock {
  now(): Instant {
    return instant(BigInt(Date.now()));
  }
}
