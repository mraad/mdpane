// Switching files while a timed read is in flight must show the new file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { register } from '../hooks/register.js'

test('a read that finishes after /mdpane switched files is dropped', async () => {
  const h = {}
  register((ev, filter, fn) => (h[ev] = fn ?? filter))
  const files = { 'a.md': 'AAA', 'b.md': 'BBB' }
  let tick, release, hold = false
  const $ = {
    store: { get: async () => null, set: async () => {} },
    clock: { every: (_, f) => (tick = f) },
    command: { register: async () => {} },
    ui: {
      log() {}, toast() {}, invalidate() {}, open: async () => {},
      resolve: () => ({ Box: (p) => p, Text: (p) => p, Button: (p) => p, Markdown: (p) => p, Code: (p) => p }),
    },
    fs: {
      read: (p) =>
        hold && p === 'a.md'
          ? new Promise((r) => (release = () => r(files[p])))
          : Promise.resolve(files[p]),
    },
  }
  await h['session.start']($, {}, () => {})
  await h['command.run']($, { args: 'a.md' })
  hold = true
  const slow = tick() // timed read of a.md, held open
  await h['command.run']($, { args: 'b.md' }) // its own read is skipped: one is in flight
  release()
  await slow
  const pane = await h['ui.render']($, { requestId: 'mdpane', props: { bodyColumns: 40 } }, () => {})
  const shown = JSON.stringify(pane)
  assert.ok(shown.includes('BBB') && !shown.includes('AAA'), shown)
})
