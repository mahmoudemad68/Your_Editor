/** Official Remotion hook: replace SDK timing approximations with admitted rational values.
 * These are SDK-owned argument arrays, never client-supplied commands or filter strings. */
export function exactEncoderTiming(
  args: readonly string[],
  rate: { numerator: number; denominator: number },
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
  return result;
}
