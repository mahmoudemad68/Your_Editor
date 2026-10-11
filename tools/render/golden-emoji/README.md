# Independent emoji glyph references

These PNGs are the exact embedded CBDT glyph bytes in official Noto Color Emoji 2.051, font SHA-256 `72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b`. Source: <https://github.com/googlefonts/noto-emoji/tree/v2.051>. License: SIL Open Font License 1.1, copied in LICENSE.

References were extracted using fontTools 4.61.1: `TTFont(font)['CBDT'].strikeData[0][glyph].imageData`. The text, GSUB-selected glyph names and exact PNG identities are in references.json. No Chromium output was used to define them. No generation dependency is added to production or CI: committed references are decoded using the existing FFmpeg test tool and their hashes are verified before comparison.

Actual rendered MP4 frame 15 is compared to the independent reference's cropped 12×12 spatial RGB signature. A fixed mean error below 30/255 allows encoding/scaling noise; at least 150 colored pixels rejects monochrome tofu. This checks visible color and shape, rather than relying on DOM text or nonblack pixels. End frame 30 must be black, and two separate grinning-face renders must match decoded frame hashes exactly. Runtime images pin the font bytes; tests never download a font.
