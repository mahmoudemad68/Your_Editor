/** Official Remotion hook: replace SDK timing approximations with admitted rational values.
 * These are SDK-owned argument arrays, never client-supplied commands or filter strings. */
export function exactEncoderTiming(
  args: readonly string[],
  rate: { numerator: number; denominator: number },
  componentBoundaries: readonly number[] = [],
): string[] {
  if (
    !Number.isSafeInteger(rate.numerator) ||
    !Number.isSafeInteger(rate.denominator) ||
    rate.numerator < 1 ||
    rate.numerator > 60000 ||
    rate.denominator < 1 ||
    rate.denominator > 1001 ||
    rate.numerator / rate.denominator < 1 ||
    rate.numerator / rate.denominator > 60 ||
    args.length < 2
  )
    throw new Error("Invalid encoder timing.");
  if (
    componentBoundaries.length > 4096 ||
    componentBoundaries.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 108000)
  )
    throw new Error("Invalid component frame boundary.");
  const result = [...args];
  let timescale = false;
  for (let i = 0; i < result.length; i++) {
    if (["-r", "-framerate", "-video_track_timescale"].includes(result[i]!)) {
      if (i + 1 >= result.length - 1) throw new Error("Malformed SDK timing option.");
      const scale = result[i] === "-video_track_timescale";
      result[++i] = scale ? String(rate.numerator) : `${rate.numerator}/${rate.denominator}`;
      timescale ||= scale;
    }
  }
  // Stream-copy stitching must retain the same exact timebase as pre-encoding.
  if (!timescale)
    result.splice(result.length - 1, 0, "-video_track_timescale", String(rate.numerator));
  const copy = args.some((v, i) => ["-c", "-c:v", "-vcodec"].includes(v) && args[i + 1] === "copy");
  if (!copy && componentBoundaries.length) {
    // A fresh intra frame at text visibility boundaries prevents colored glyph
    // chroma prediction residue surviving the exact removal frame. Keep CRF,
    // pixel format, source timing and normal GOP policy unchanged elsewhere.
    // FFmpeg rounds this list to its encoder timebase. Twelve decimal places
    // derived with integer arithmetic locate the exact admitted rational frame.
    const scale = 1000000000000n,
      divisor = BigInt(rate.numerator);
    const seconds = [...new Set(componentBoundaries)]
      .sort((a, b) => a - b)
      .map((n) => {
        const value = (BigInt(n) * BigInt(rate.denominator) * scale + divisor / 2n) / divisor;
        return `${value / scale}.${String(value % scale).padStart(12, "0")}`;
      });
    result.splice(result.length - 1, 0, "-force_key_frames", seconds.join(","));
  }
  return result;
}
