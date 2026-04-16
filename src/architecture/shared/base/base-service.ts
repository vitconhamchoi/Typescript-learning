import type { Logger } from "../logging/logger.js";
import type { Monitor } from "../monitoring/monitor.js";

export abstract class BaseService {
  protected constructor(
    protected readonly logger: Logger,
    protected readonly monitor: Monitor,
  ) {}

  protected recordLatency(metric: string, startedAt: number): void {
    this.monitor.timing(metric, Date.now() - startedAt);
  }
}
