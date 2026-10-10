/** Decimal parsing with nearest microsecond, half away from zero. Never Number(seconds). */
export function decimalSecondsUs(text: string): bigint {
  const match = /^(-?)([0-9]{1,13})(?:\.([0-9]{1,12}))?$/.exec(text);
  if (!match) throw new Error("Malformed decimal timestamp.");
  const fraction = (match[3] ?? "").padEnd(7, "0");
  let us = BigInt(match[2]!) * 1000000n + BigInt(fraction.slice(0, 6));
  if (fraction[6]! >= "5") us++;
  if (us > 9223372036854775807n) throw new Error("Media time overflow.");
  return match[1] === "-" ? -us : us;
}
export interface SilenceRange {
  readonly startUs: string;
  readonly endUs: string;
}
export function parseSilence(text: string, durationUs: bigint): readonly SilenceRange[] {
  const ranges: SilenceRange[] = [];
  let start: bigint | undefined,
    previous = 0n;
  for (const line of text.split("\n")) {
    if (
      (line.includes("silence_start") && !line.includes("silence_start:")) ||
      (line.includes("silence_end") && !line.includes("silence_end:"))
    )
      throw new Error("Truncated silence diagnostic.");
    if (!line.includes("silence_start:") && !line.includes("silence_end:")) continue;
    if (line.includes("silence_start:")) {
      const value = /silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(line)?.[1];
      if (!value || start !== undefined) throw new Error("Malformed silence start.");
      start = decimalSecondsUs(value);
      if (start < previous || start < 0n || start >= durationUs)
        throw new Error("Invalid silence start.");
    } else {
      const match =
        /silence_end:\s*(-?[0-9]+(?:\.[0-9]+)?)\s*\|\s*silence_duration:\s*([0-9]+(?:\.[0-9]+)?)(?:\s|$)/.exec(
          line,
        );
      if (!match || start === undefined) throw new Error("Malformed silence end.");
      const end = decimalSecondsUs(match[1]!);
      if (end <= start || end > durationUs || abs(end - start - decimalSecondsUs(match[2]!)) > 100n)
        throw new Error("Invalid silence range.");
      ranges.push({ startUs: start.toString(), endUs: end.toString() });
      previous = end;
      start = undefined;
    }
  }
  // Only a successful, duration-verified decode may close a valid trailing start.
  if (start !== undefined) ranges.push({ startUs: start.toString(), endUs: durationUs.toString() });
  return ranges;
}
function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
function measurement(text: string | undefined, min: number, max: number): number {
  if (text === undefined || !/^-?[0-9]+(?:\.[0-9]+)?$/.test(text))
    throw new Error("Missing/malformed EBU R128 measurement.");
  const number = Number(text);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new Error("Invalid EBU R128 measurement.");
  return number;
}
export function parseLoudness(
  text: string,
  durationUs: bigint,
): {
  loudness: { integratedLufs: number; loudnessRangeLu: number; truePeakDbtp: number };
  shortTermLoudness: { atUs: string; lufs: number }[];
} {
  const summary = text.slice(text.lastIndexOf("Summary:"));
  if (!text.includes("Summary:")) throw new Error("Missing EBU summary.");
  const loudness = {
    integratedLufs: measurement(/\bI:\s*(\S+)\s+LUFS/.exec(summary)?.[1], -200, 100),
    loudnessRangeLu: measurement(/\bLRA:\s*(\S+)\s+LU/.exec(summary)?.[1], 0, 200),
    // Digital silence has a mathematically -infinite true peak; canonical floor -200 dBTP.
    truePeakDbtp: /Peak:\s*-inf\s+dBFS/.test(summary)
      ? -200
      : measurement(/Peak:\s*(\S+)\s+dBFS/.exec(summary)?.[1], -200, 100),
  };
  const shortTermLoudness: { atUs: string; lufs: number }[] = [];
  let lastBucket = -1n;
  for (const line of text.split("\n")) {
    const match = /\bt:\s*(\S+).*\bS:\s*(\S+)\s+I:/.exec(line);
    if (!match) continue;
    const at = decimalSecondsUs(match[1]!);
    if (at < 0n || at > durationUs) throw new Error("Invalid short-term time.");
    const bucket = at / 1000000n;
    if (bucket !== lastBucket) {
      shortTermLoudness.push({ atUs: at.toString(), lufs: measurement(match[2], -200, 100) });
      lastBucket = bucket;
    }
  }
  if (durationUs >= 100000n && shortTermLoudness.length === 0)
    throw new Error("Missing short-term loudness measurements.");
  if (shortTermLoudness.length > 1800) throw new Error("Unbounded short-term output.");
  return { loudness, shortTermLoudness };
}
/** Streaming mono PCM float buckets; at most one read chunk plus 18,000 output buckets. */
export class PcmBuckets {
  private pending = Buffer.alloc(0);
  private samples = 0;
  private count = 0;
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;
  readonly energyCurve: { atUs: string; rmsDbfs: number }[] = [];
  readonly waveformPeaks: { atUs: string; minimum: number; maximum: number }[] = [];
  readonly bucketSamples: number;
  constructor(
    readonly rate: number,
    readonly bucketUs: bigint,
    readonly durationUs: bigint,
  ) {
    this.bucketSamples = Number((bucketUs * BigInt(rate)) / 1000000n);
    if (this.bucketSamples < 1 || durationUs <= 0n)
      throw new Error("Invalid PCM bucket configuration.");
  }
  push(chunk: Buffer): void {
    const data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    let at = 0;
    for (; at + 4 <= data.length; at += 4) {
      const sample = data.readFloatLE(at);
      if (!Number.isFinite(sample)) throw new Error("Nonfinite PCM sample.");
      if (this.samples >= Number((this.durationUs * BigInt(this.rate) + 999999n) / 1000000n))
        throw new Error("PCM exceeds declared duration.");
      this.count++;
      this.samples++;
      this.sum += sample * sample;
      this.min = Math.min(this.min, sample);
      this.max = Math.max(this.max, sample);
      if (this.count === this.bucketSamples) this.flush();
    }
    this.pending = Buffer.from(data.subarray(at));
  }
  finish(): void {
    if (
      this.pending.length ||
      Math.abs(this.samples - Number((this.durationUs * BigInt(this.rate)) / 1000000n)) > 1
    )
      throw new Error("Truncated or inconsistent PCM duration.");
    if (this.count) this.flush();
  }
  private flush(): void {
    if (this.energyCurve.length >= 18000) throw new Error("Energy point bound exceeded.");
    const atUs = ((BigInt(this.samples - this.count) * 1000000n) / BigInt(this.rate)).toString();
    this.energyCurve.push({
      atUs,
      rmsDbfs: Math.max(
        -200,
        Math.min(0, this.sum === 0 ? -200 : 10 * Math.log10(this.sum / this.count)),
      ),
    });
    this.waveformPeaks.push({
      atUs,
      minimum: Math.max(-1, Math.min(1, this.min)),
      maximum: Math.max(-1, Math.min(1, this.max)),
    });
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }
}
