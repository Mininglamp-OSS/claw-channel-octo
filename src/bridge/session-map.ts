/**
 * Message deduplication cache with TTL.
 *
 * The Octo event polling loop may redeliver the same event before our ack
 * lands; this set guards the inbound bridge against double-publishing.
 */
export class MessageDedup {
  private readonly seen = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly ttlMs = 5 * 60 * 1000) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  isDuplicate(msgId: string): boolean {
    const key = String(msgId);
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, ts] of this.seen) {
      if (now - ts > this.ttlMs) {
        this.seen.delete(id);
      }
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.seen.clear();
  }
}
