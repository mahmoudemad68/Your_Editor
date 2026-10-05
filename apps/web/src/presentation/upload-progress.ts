export interface TransferProgress {
  readonly loaded: number;
  readonly durableLoaded: number;
  readonly total: number;
  readonly percent: number;
  readonly speed: number;
  readonly eta: number | null;
}
export class UploadProgress {
  private readonly completed = new Map<number, number>();
  private readonly inflight = new Map<number, number>();
  private wireBytes = 0;
  private samples: { at: number; bytes: number }[] = [];
  constructor(
    private readonly total: number,
    parts: readonly { partNumber: number; byteSize: number }[],
    private readonly now: () => number = () => performance.now(),
  ) {
    for (const part of parts) this.completed.set(part.partNumber, part.byteSize);
    this.samples.push({ at: now(), bytes: 0 });
  }
  progress(part: number, loaded: number): void {
    if (this.completed.has(part)) return;
    const before = this.inflight.get(part) ?? 0;
    this.wireBytes += Math.max(0, loaded - before);
    this.inflight.set(part, loaded);
  }
  reset(part: number): void {
    this.inflight.delete(part);
  }
  commit(part: number, bytes: number): void {
    this.inflight.delete(part);
    this.completed.set(part, bytes);
  }
  pause(): void {
    this.inflight.clear();
  }
  snapshot(done = false): TransferProgress {
    const at = this.now();
    this.samples.push({ at, bytes: this.wireBytes });
    while (this.samples.length > 2 && this.samples[1]!.at < at - 5000) this.samples.shift();
    const first = this.samples[0]!;
    const elapsed = at - first.at;
    const speed = elapsed < 500 ? 0 : ((this.wireBytes - first.bytes) * 1000) / elapsed;
    const loaded = Math.min(
      this.total,
      [...this.completed.values(), ...this.inflight.values()].reduce((sum, n) => sum + n, 0),
    );
    return {
      loaded,
      durableLoaded: [...this.completed.values()].reduce((sum, n) => sum + n, 0),
      total: this.total,
      percent: done ? 100 : Math.min(99.9, (loaded / this.total) * 100),
      speed,
      eta: speed > 0 ? (this.total - loaded) / speed : null,
    };
  }
}
export function missingParts(
  byteSize: number,
  partSize: number,
  completed: readonly { partNumber: number }[],
): number[] {
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < 1 ||
    byteSize > 4 * 1024 ** 3 ||
    partSize < 5 * 1024 ** 2
  )
    throw new Error("Invalid multipart plan.");
  const count = Math.ceil(byteSize / partSize);
  if (count > 10_000) throw new Error("Invalid multipart plan.");
  const done = new Set(completed.map((p) => p.partNumber));
  return Array.from({ length: count }, (_, i) => i + 1).filter((n) => !done.has(n));
}
