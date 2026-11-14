export interface ProblemEntry {
  at: number;
  /** What was being done, e.g. "stream tt0063350" or "provider internet-archive". */
  context: string;
  message: string;
}

/** Small in-memory ring buffer of recent problems, shown on /status for remote debugging. */
export class ErrorLog {
  private readonly entries: ProblemEntry[] = [];

  constructor(
    private readonly capacity = 30,
    private readonly now: () => number = Date.now,
  ) {}

  record(context: string, message: string): void {
    this.entries.unshift({ at: this.now(), context, message: message.slice(0, 300) });
    if (this.entries.length > this.capacity) this.entries.length = this.capacity;
  }

  recent(limit = this.capacity): ProblemEntry[] {
    return this.entries.slice(0, limit);
  }
}
