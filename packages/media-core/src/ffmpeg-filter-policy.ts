/** Fail-closed policy for fixed media-core recipes. No filenames, URLs or general expressions. */
function bad(): never {
  throw new Error("Unsupported FFmpeg filter option.");
}
const decimal = (v: string, min: number, max: number, integer = false) => {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v)) bad();
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) bad();
};
const count = (v: string) => decimal(v, 0, 108000000, true);
const duration = (v: string) => decimal(v, 0, 1800);
const dimension = (v: string) => decimal(v, 2, 4096, true);
const rate = (v: string) => {
  if (!/^[1-9][0-9]*(?:\/[1-9][0-9]*)?$/.test(v)) bad();
  const [n, d = 1] = v.split("/").map(Number);
  if (!n || n > 60000 || !d || d > 60000 || n / d > 192000) bad();
};
const frameRate = (v: string) => {
  rate(v);
  const [n, d = 1] = v.split("/").map(Number);
  if (!n || n / d < 1 || n / d > 60) bad();
};
function options(
  v: string,
  policy: Record<string, (value: string) => void>,
  required: string[] = [],
) {
  const seen = new Set<string>();
  for (const part of v.split(":")) {
    const pair = /^([a-zA-Z_]+)=(.+)$/.exec(part);
    if (!pair || !Object.hasOwn(policy, pair[1]!) || seen.has(pair[1]!)) bad();
    seen.add(pair[1]!);
    policy[pair[1]!]!(pair[2]!);
  }
  if (required.some((k) => !seen.has(k))) bad();
}
const exact =
  (...values: string[]) =>
  (v: string) => {
    if (!values.includes(v)) bad();
  };
function validate(part: string) {
  const match = /^([a-z][a-z0-9]*)(?:=(.*))?$/.exec(part);
  if (!match) bad();
  const name = match![1]!,
    v = match![2] ?? "";
  switch (name) {
    case "silencedetect":
      return options(
        v,
        {
          noise: (n) => {
            if (!n.endsWith("dB")) bad();
            decimal(n.slice(0, -2), -100, 0);
          },
          d: duration,
        },
        ["noise", "d"],
      );
    case "ebur128":
      return exact("peak=true:framelog=info")(v);
    case "aresample":
      return v.includes("=") ? exact("async=1:first_pts=0")(v) : decimal(v, 8000, 192000, true);
    case "setsar":
      return exact("1")(v);
    case "setpts":
      if (v === "PTS-STARTPTS" || v === "N") return;
      if (!/^PTS\*[1-9][0-9]{0,3}\/[1-9][0-9]{0,3}$/.test(v)) bad();
      {
        const [n, d] = v.slice(4).split("/").map(Number);
        if (!n || !d || n / d < 0.25 || n / d > 4) bad();
      }
      return;
    case "asetpts":
      return exact("PTS-STARTPTS", "N/SR/TB")(v);
    case "settb":
      return options(v, { expr: rate }, ["expr"]);
    case "asettb":
      return exact("1/48000")(v);
    case "tpad":
      return options(v, { stop_mode: exact("clone"), stop_duration: duration }, [
        "stop_mode",
        "stop_duration",
      ]);
    case "trim":
      return options(v, {
        start: duration,
        end: duration,
        duration,
        start_frame: count,
        end_frame: count,
      });
    case "atrim":
      return options(v, {
        start: duration,
        end: duration,
        duration,
        start_sample: count,
        end_sample: count,
      });
    case "apad":
      return v === "" ? undefined : options(v, { whole_len: count, pad_dur: duration });
    case "fps":
      if (!v.startsWith("fps=") && v.includes(":")) {
        const [value, ...rest] = v.split(":");
        // Historical US-128 midpoint sprites sample count/source-seconds, which
        // can be below one fps, and start at the first midpoint. This positional
        // spelling is kept bounded separately from composition frame rates.
        const fraction = /^([1-9]|1[0-9]|20)\/(.+)$/.exec(value!);
        if (fraction) {
          duration(fraction[2]!);
          const seconds = Number(fraction[2]);
          if (seconds <= 0 || Number(fraction[1]) / seconds > 60) bad();
        } else frameRate(value!);
        return options(
          rest.join(":"),
          { start_time: fraction ? duration : exact("0"), round: exact("near") },
          ["start_time", "round"],
        );
      }
      if (!v.includes("=")) return frameRate(v);
      return options(v, { fps: frameRate, start_time: exact("0"), round: exact("near") }, ["fps"]);
    case "scale": {
      const legacy = [
        "w='max(2,trunc(iw*sar*min(1,540/ih)/2)*2)':h='max(2,trunc(ih*min(1,540/ih)/2)*2)'",
        "w='max(2,trunc(iw*sar/2)*2)':h=ih",
      ];
      if (legacy.includes(v)) return;
      const pieces = v.split(":");
      if (pieces.length < 2 || pieces.length > 4) bad();
      dimension(pieces[0]!);
      dimension(pieces[1]!);
      if (pieces.length > 2)
        options(pieces.slice(2).join(":"), {
          force_original_aspect_ratio: exact("decrease"),
          force_divisible_by: exact("2"),
        });
      return;
    }
    case "pad": {
      const p = v.split(":");
      if (p.length < 4 || p.length > 5) bad();
      dimension(p[0]!);
      dimension(p[1]!);
      exact("(ow-iw)/2")(p[2]!);
      exact("(oh-ih)/2")(p[3]!);
      if (p[4] && !/^color=0x[0-9a-fA-F]{6}$/.test(p[4])) bad();
      return;
    }
    case "select":
      if (!/^'eq\(n,[0-9]{1,6}\)(?:\+eq\(n,[0-9]{1,6}\)){0,19}'$/.test(v)) bad();
      return;
    case "tile":
      if (!/^[1-5]x(?:[1-9]|1[0-9]|20):nb_frames=(?:[1-9]|1[0-9]|20)$/.test(v)) bad();
      return;
    case "concat":
      return options(v, { n: (n) => decimal(n, 1, 32, true), v: exact("1"), a: exact("0", "1") }, [
        "n",
        "v",
        "a",
      ]);
    case "color":
      return options(
        v,
        {
          c: (c) => {
            if (!/^0x[0-9a-fA-F]{6}$/.test(c)) bad();
          },
          s: (s) => {
            const p = s.split("x");
            if (p.length !== 2) bad();
            dimension(p[0]!);
            dimension(p[1]!);
          },
          r: frameRate,
          d: duration,
        },
        ["c", "s", "r"],
      );
    case "anullsrc":
      return options(v, { r: exact("48000"), cl: exact("stereo"), d: duration }, ["r", "cl"]);
    case "aformat":
      return exact("sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo")(v);
    case "volume":
      return decimal(v, 0, 4);
    case "crop": {
      const p = v.split(":");
      if (p.length !== 4) bad();
      dimension(p[0]!);
      dimension(p[1]!);
      decimal(p[2]!, 0, 4096, true);
      decimal(p[3]!, 0, 4096, true);
      return;
    }
    case "atempo":
      return decimal(v, 0.5, 2);
    case "acrossfade":
      return exact("d=0.005:o=0:c1=tri:c2=tri")(v);
    case "loudnorm":
      return options(
        v,
        {
          I: (n) => decimal(n, -70, -5),
          LRA: (n) => decimal(n, 1, 50),
          TP: (n) => decimal(n, -9, 0),
          print_format: exact("json"),
          linear: exact("true", "false"),
          measured_I: (n) => decimal(n, -100, 20),
          measured_LRA: (n) => decimal(n, 0, 100),
          measured_TP: (n) => decimal(n, -100, 30),
          measured_thresh: (n) => decimal(n, -100, 0),
          offset: (n) => decimal(n, -99, 99),
        },
        ["I", "LRA", "TP"],
      );
    default:
      bad();
  }
}
export function checkFilterGraph(graph: string, complex: boolean): void {
  if (
    typeof graph !== "string" ||
    graph.length > 32768 ||
    [...graph].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    bad();
  const parts: string[] = [];
  let part = "",
    quoted = false;
  for (const c of graph) {
    // Recipes do not contain escaped text or user-controlled expression strings.
    if (c === "\\" || c === '"') bad();
    if (c === "'") quoted = !quoted;
    if (!quoted && (c === "," || c === ";")) {
      if (c === ";" && !complex) bad();
      parts.push(part);
      part = "";
    } else part += c;
  }
  if (quoted) bad();
  parts.push(part);
  if (parts.length > (complex ? 256 : 32)) bad();
  for (let component of parts) {
    if (complex) {
      component = component
        .replace(/^(?:\[(?:[0-9]{1,2}:[va](?::0)?|[a-z][a-z0-9]{0,15})\])+/, "")
        .replace(/(?:\[[a-z][a-z0-9]{0,15}\])+$/, "");
    }
    if (component.includes("[") || component.includes("]")) bad();
    validate(component);
  }
}
