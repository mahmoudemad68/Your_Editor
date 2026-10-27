import React, { useLayoutEffect, useRef } from "react";
import { useCurrentFrame } from "remotion";
import { captionWordAtFrame, safeCaptionZone, type ProjectedCaptionV1 } from "@editagent/domain";
import { UnicodeText } from "./unicode-text.js";

export const WORD_CAPTION_COMPONENT = "word-captions-v1";
export interface WordCaptionPropsV1 {
  schemaVersion: "1.0.0";
  caption: ProjectedCaptionV1;
  width: number;
  height: number;
  frameRate: { numerator: string; denominator: string };
}
interface HighlightWindow {
  Highlight: new (...ranges: Range[]) => unknown;
  CSS: { highlights: { set(name: string, highlight: unknown): void; delete(name: string): void } };
}
/** One continuous shaped text stream. Native Range highlighting changes paint,
 * never Arabic/Bidi layout or word DOM boundaries. No innerHTML or remote fonts.
 */
export const WordCaption: React.FC<WordCaptionPropsV1> = (p) => {
  const f = useCurrentFrame(),
    ref = useRef<HTMLDivElement>(null),
    c = p.caption;
  const words = c.lines.flat(),
    active = captionWordAtFrame(words, BigInt(f), {
      numerator: BigInt(p.frameRate.numerator),
      denominator: BigInt(p.frameRate.denominator),
    });
  const display = c.lines.map((l) => l.map((w) => w.text.trim()).join(" ")).join("\n");
  const zone = safeCaptionZone(p.width, p.height, c.style);
  const name = `caption-${c.captionId}-${c.sourceClipId}`;
  useLayoutEffect(() => {
    const root = ref.current,
      browser = window as unknown as HighlightWindow;
    if (!root) return;
    const bounds = root.getBoundingClientRect(),
      zoneBounds = root.parentElement!.getBoundingClientRect();
    if (
      root.scrollWidth > root.clientWidth + 1 ||
      root.scrollHeight > root.clientHeight + 1 ||
      bounds.left < zoneBounds.left - 0.5 ||
      bounds.top < zoneBounds.top - 0.5 ||
      bounds.right > zoneBounds.right + 0.5 ||
      bounds.bottom > zoneBounds.bottom + 0.5
    )
      throw new Error("Caption layout exceeds its safe zone.");
    if (!browser.Highlight || !browser.CSS?.highlights)
      throw new Error("Native caption highlighting is unsupported.");
    browser.CSS.highlights.delete(name);
    if (active < 0) return;
    let start = 0;
    for (let i = 0; i < active; i++) start += words[i]!.text.trim().length + 1;
    const stop = start + words[active]!.text.trim().length;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT),
      range = document.createRange();
    let offset = 0,
      begun = false,
      complete = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const end = offset + (node.textContent?.length ?? 0);
      if (!begun && start >= offset && start < end) {
        range.setStart(node, start - offset);
        begun = true;
      }
      if (begun && stop <= end) {
        range.setEnd(node, stop - offset);
        complete = true;
        break;
      }
      offset = end;
    }
    if (!complete) throw new Error("Caption text range differs from its timed words.");
    browser.CSS.highlights.set(name, new browser.Highlight(range));
    return () => browser.CSS.highlights.delete(name);
  }, [active, display, name]);
  const rate = {
    numerator: BigInt(p.frameRate.numerator),
    denominator: BigInt(p.frameRate.denominator),
  };
  // Global composition frame, not a Sequence-relative clock.
  const clock =
    (BigInt(f) * 1000000n * rate.denominator * 2n + rate.numerator) / (2n * rate.numerator);
  if (clock < BigInt(c.startUs) || clock >= BigInt(c.endUs)) return null;
  return (
    <div
      data-caption-component={WORD_CAPTION_COMPONENT}
      data-caption-id={c.captionId}
      data-active-word={active}
      style={{
        position: "absolute",
        left: zone.x,
        top: zone.y,
        width: zone.width,
        height: zone.height,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        pointerEvents: "none",
        overflow: "hidden",
      }}
    >
      <style>{`::highlight(${name}) { color: ${c.style.highlight}; }`}</style>
      <div
        ref={ref}
        dir={c.style.direction}
        data-caption-text="true"
        style={{
          whiteSpace: "pre",
          fontFamily: '"DejaVu Sans", "Noto Color Emoji", sans-serif',
          fontSize: c.style.fontSize,
          lineHeight: 1.5,
          textAlign: "center",
          unicodeBidi: "plaintext",
          color: c.style.color,
          backgroundColor: c.style.background,
          padding: 8,
          WebkitTextStroke: `${c.style.outlinePx}px ${c.style.outline}`,
          textShadow: `${c.style.shadowPx}px ${c.style.shadowPx}px ${c.style.shadowPx}px ${c.style.outline}`,
        }}
      >
        <UnicodeText text={display} />
      </div>
    </div>
  );
};
