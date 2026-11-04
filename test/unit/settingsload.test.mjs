import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceLoader } from '../lib/load.mjs'

// Stored settings arrive asynchronously. A change made before they arrive
// must survive the load, and must not discard the other stored fields. A
// fake desktop bridge (this file runs in its own process) holds the load.

let deliver
const writes = []
globalThis.window = {
  pgdevDesktop: {
    storage: {
      load: () => new Promise((resolve) => { deliver = resolve }),
      write: async (kind, value) => { writes.push([kind, value]) },
    },
  },
}

const { useSettings } = await sourceLoader()('web/composables/settings.ts')

test('an early change keeps its value and the rest of the stored settings still load', async () => {
  const settings = useSettings()
  // Before storage answers: the user changes the font size and grouping.
  settings.setEditorFontSize(20)
  settings.setGroupObjects(false)
  settings.setBrowserState('conn-a', { sections: { tables: true } })
  deliver({
    settings: {
      editorFontSize: 12, groupObjects: true, statementTimeout: 90, aiLimitRows: 250,
      panelSizes: { sideW: 400, resultsH: 300 },
      browserExpanded: { 'conn-a': { sections: { views: true } }, 'conn-b': { sections: { types: true } } },
    },
    connections: undefined,
    pinnedFiles: [],
  })
  await settings.ready
  // The user's own changes win…
  assert.equal(settings.state.editorFontSize, 20)
  assert.equal(settings.state.groupObjects, false)
  assert.equal(settings.browserStateFor('conn-a')?.sections.tables, true)
  assert.equal(settings.browserStateFor('conn-a')?.sections.views, false)
  // …and every field they did not touch comes from storage.
  assert.equal(settings.state.statementTimeout, 90)
  assert.equal(settings.state.aiLimitRows, 250)
  assert.equal(settings.state.panelSizes.sideW, 400)
  assert.equal(settings.browserStateFor('conn-b')?.sections.types, true)
})
