// Reusable concurrency-overlap primitive: N concurrent callers each call
// wait(), and all are released together once the Nth arrives. A bounded
// timeout is required, not optional -- if one concurrent request exits
// early (e.g. an earlier validation failure never reaches the barrier), the
// other request must not hang forever. It fails loudly with a diagnostic
// naming the arrived vs. expected participant count, which is also a
// genuinely useful signal if a route's code path changes in a way that
// stops reaching the contended write at all.
export class AsyncBarrier {
  private count = 0;
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(
    private readonly parties: number,
    private readonly timeoutMs = 5000
  ) {}

  async wait(): Promise<void> {
    this.count += 1;
    if (this.count >= this.parties) {
      this.waiters.forEach((w) => w.resolve());
      this.waiters = [];
      return;
    }
    const arrivedAtTimeout = () => this.count;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`AsyncBarrier timed out after ${this.timeoutMs}ms: ${arrivedAtTimeout()}/${this.parties} participants arrived`));
      }, this.timeoutMs);
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
}
