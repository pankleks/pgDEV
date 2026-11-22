// Release notes from GitHub (Markdown) as plain blocks and spans that the
// update dialog renders with ordinary text nodes: never HTML, so nothing in
// the notes can inject markup or script. Only what the notes use is kept:
// headings, bullet lists (nested by indent), quotes, paragraphs, and inline
// **bold** and `code`. Links show their text; images and raw HTML tags are
// dropped to their text.

export interface NoteSpan {
  text: string
  bold?: boolean
  code?: boolean
}

export type NoteBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; spans: NoteSpan[] }
  | { kind: 'item'; depth: number; spans: NoteSpan[] }
  | { kind: 'quote'; spans: NoteSpan[] }
  | { kind: 'paragraph'; spans: NoteSpan[] }

/** Inline Markdown to spans: `code`, **bold**, [text](url) → text. */
export function noteSpans(text: string): NoteSpan[] {
  const spans: NoteSpan[] = []
  const push = (value: string, style: Omit<NoteSpan, 'text'> = {}) => {
    if (!value) return
    const last = spans.at(-1)
    if (last && !last.code && !style.code && !!last.bold === !!style.bold) last.text += value
    else spans.push({ text: value, ...style })
  }
  // Images and links keep their text; HTML tags are removed.
  const plain = (value: string) => value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
  const parts = text.split(/(`[^`]+`)/)
  for (const part of parts) {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      push(part.slice(1, -1), { code: true })
      continue
    }
    const pieces = plain(part).split(/(\*\*[^*]+\*\*|__[^_]+__)/)
    for (const piece of pieces) {
      const bold = piece.length > 4 && ((piece.startsWith('**') && piece.endsWith('**')) || (piece.startsWith('__') && piece.endsWith('__')))
      push(bold ? piece.slice(2, -2) : piece, bold ? { bold: true } : {})
    }
  }
  return spans
}

/** Block structure of the notes; consecutive text lines join a paragraph. */
export function noteBlocks(markdown: string): NoteBlock[] {
  const blocks: NoteBlock[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', spans: noteSpans(paragraph.join(' ')) })
    paragraph = []
  }
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\t/g, '  ')
    if (!line.trim()) { flush(); continue }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flush()
      const level = Math.min(3, (heading[1] as string).length) as 1 | 2 | 3
      blocks.push({ kind: 'heading', level, spans: noteSpans(heading[2] as string) })
      continue
    }
    const item = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flush()
      blocks.push({ kind: 'item', depth: Math.min(3, Math.floor((item[1] as string).length / 2)), spans: noteSpans(item[2] as string) })
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      flush()
      const text = quote[1] as string
      const previous = blocks.at(-1)
      // A quote spanning several lines stays one block.
      if (previous?.kind === 'quote' && text.trim()) previous.spans.push({ text: ' ' }, ...noteSpans(text))
      else if (text.trim()) blocks.push({ kind: 'quote', spans: noteSpans(text) })
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}
