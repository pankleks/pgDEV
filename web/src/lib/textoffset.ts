// PostgreSQL reports error positions in characters (code points), while
// JavaScript strings and Monaco offsets count UTF-16 code units: every
// character outside the Basic Multilingual Plane (emoji, some CJK) is two.

/** UTF-16 index of the `codePoints`-th code point of `text` (clamped). */
export function codePointsToIndex(text: string, codePoints: number): number {
  let index = 0
  for (let seen = 0; seen < codePoints && index < text.length; seen++) {
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1
  }
  return index
}
