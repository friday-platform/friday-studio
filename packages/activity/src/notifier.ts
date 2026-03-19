export class ActivityNotifier {
  private subscribers = new Set<() => void>();

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  notify(): void {
    for (const cb of this.subscribers) {
      cb();
    }
  }
}
