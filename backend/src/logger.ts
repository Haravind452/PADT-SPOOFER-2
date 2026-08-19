export interface LogSink {
  (line: string): void;
}

export class Logger {
  private lines: string[] = [];
  private readonly limit: number;
  private sink: LogSink | null = null;

  constructor(limit = 500) {
    this.limit = limit;
  }

  onLine(sink: LogSink): void {
    this.sink = sink;
  }

  log(message: string): void {
    const ts = new Date()
      .toISOString()
      .slice(11, 19);
    const line = `[${ts}] ${message}`;
    this.lines.push(line);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    // Print to the backend terminal as well as the UI log via the sink.
    // eslint-disable-next-line no-console
    console.log(line);
    if (this.sink) this.sink(line);
  }

  history(): string[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }
}