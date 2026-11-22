import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

const load = sourceLoader()
const { noteBlocks, noteSpans } = await load('web/lib/releasenotes.ts')

// Release notes are rendered from these blocks as plain text nodes, so the
// formatter only has to keep structure; it never produces HTML.

test('inline code, bold and links become plain spans', () => {
  assert.deepEqual(noteSpans('Use `F12` to **open** [the docs](https://x.example) now'), [
    { text: 'Use ' }, { text: 'F12', code: true }, { text: ' to ' }, { text: 'open', bold: true }, { text: ' the docs now' },
  ])
  assert.deepEqual(noteSpans('a `**not bold**` b'), [{ text: 'a ' }, { text: '**not bold**', code: true }, { text: ' b' }])
  assert.deepEqual(noteSpans('![logo](x.png) __strong__'), [{ text: 'logo ' }, { text: 'strong', bold: true }])
})

test('HTML in the notes is reduced to text, never kept as markup', () => {
  const spans = noteSpans('<img src=x onerror=alert(1)>Hi <script>alert(1)</script><b>there</b>')
  assert.equal(spans.map((s) => s.text).join(''), 'Hi alert(1)there')
  // Code spans keep their characters verbatim; the dialog shows them as text.
  assert.deepEqual(noteSpans('`<script>`'), [{ text: '<script>', code: true }])
})

test('blocks: headings, nested items, quotes and joined paragraphs', () => {
  const blocks = noteBlocks([
    '## What\'s new',
    '',
    '- **Open Definition.** Select a name',
    '  - nested detail',
    '* star item',
    '1. numbered',
    '',
    '> **Note:** first line',
    '> second line',
    '',
    'A paragraph',
    'continues here.',
    '---',
    '#### Deep heading ####',
  ].join('\r\n'))
  assert.deepEqual(blocks.map((b) => [b.kind, b.level ?? b.depth ?? null, b.spans.map((s) => s.text).join('')]), [
    ['heading', 2, "What's new"],
    ['item', 0, 'Open Definition. Select a name'],
    ['item', 1, 'nested detail'],
    ['item', 0, 'star item'],
    ['item', 0, 'numbered'],
    ['quote', null, 'Note: first line second line'],
    ['paragraph', null, 'A paragraph continues here.'],
    ['heading', 3, 'Deep heading'],
  ])
  assert.equal(blocks[1].spans[0].bold, true)
})

test('empty notes give no blocks', () => {
  assert.deepEqual(noteBlocks(''), [])
  assert.deepEqual(noteBlocks('\n\n   \n'), [])
})
