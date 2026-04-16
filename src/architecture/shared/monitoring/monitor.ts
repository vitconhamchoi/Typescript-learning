export interface Monitor {
  increment(metric: string, value?: number, tags?: Record<string, string>): void;
  timing(metric: string, valueMs: number, tags?: Record<string, string>): void;
  snapshot(): Readonly<{ counters: Record<string, number>; timings: Record<string, number[]> }>;
}

export class InMemoryMonitor implements Monitor {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, number[]>();

  increment(metric: string, value: number = 1): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + value);
  }

  timing(metric: string, valueMs: number): void {
    const current = this.timings.get(metric) ?? [];
    this.timings.set(metric, [...current, valueMs]);
  }

  snapshot(): Readonly<{ counters: Record<string, number>; timings: Record<string, number[]> }> {
    return {
      counters: Object.fromEntries(this.counters),
      timings: Object.fromEntries(this.timings),
    };
  }
}
