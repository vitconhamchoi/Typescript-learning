export interface Monitor {
  increment(metric: string, value?: number): void;
  timing(metric: string, valueMs: number): void;
  snapshot(): Readonly<{ counters: Record<string, number>; timings: Record<string, number[]> }>;
}
