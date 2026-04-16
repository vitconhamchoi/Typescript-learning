export interface Monitor {
  increment(metric: string, value?: number, tags?: Record<string, string>): void;
  timing(metric: string, valueMs: number, tags?: Record<string, string>): void;
  snapshot(): Readonly<{ counters: Record<string, number>; timings: Record<string, number[]> }>;
}
