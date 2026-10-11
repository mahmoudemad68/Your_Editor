import React from "react";

const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const emoji = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F|[0-9#*]\uFE0F?\u20E3/u;
/** Keep ordinary text in its existing font (including spaces/numbers and Arabic
 * shaping), and use the installed emoji font only for complete grapheme clusters.
 * No codepoints are replaced; VS, modifiers, ZWJ and flag pairs stay intact.
 */
export function textRuns(text: string): { text: string; emoji: boolean }[] {
  const runs: { text: string; emoji: boolean }[] = [];
  for (const { segment } of graphemes.segment(text)) {
    const isEmoji = emoji.test(segment) && !segment.includes("\uFE0E");
    const previous = runs.at(-1);
    if (previous && previous.emoji === isEmoji) previous.text += segment;
    else runs.push({ text: segment, emoji: isEmoji });
  }
  return runs;
}
export const UnicodeText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {textRuns(text).map((run, i) =>
      run.emoji ? (
        <span key={i} style={{ fontFamily: "Noto Color Emoji" }}>
          {run.text}
        </span>
      ) : (
        run.text
      ),
    )}
  </>
);
