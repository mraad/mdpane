// Run: node --test tests/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse, layout } from '../plugin/hooks/register.js'

// The visible text of each row; code rows as [code <lang>]
const rows = (md, width = 60) =>
  layout(parse(md), width).map((r) => (r.spans ? r.spans.map((s) => s.t).join('') : '[code ' + r.lang + ']'))

test('closing hashes need a space before them', () => {
  assert.deepEqual(parse('# Learn C#'), [{ type: 'heading', level: 1, text: 'Learn C#' }])
  assert.deepEqual(parse('## Title ##'), [{ type: 'heading', level: 2, text: 'Title' }])
})

test('badge: image inside a link', () => {
  assert.equal(rows('[![CI](https://x/b.svg)](https://x)')[0], '[image: CI] (https://x)')
  assert.equal(rows('[docs](https://d)')[0], 'docs (https://d)')
})

test('setext headings', () => {
  assert.deepEqual(parse('Title\n=====\n\nSub\nline\n---'), [
    { type: 'heading', level: 1, text: 'Title' },
    { type: 'heading', level: 2, text: 'Sub line' },
  ])
  assert.deepEqual(parse('---').map((b) => b.type), ['rule'])
})

test('HTML comments are hidden', () => {
  assert.deepEqual(rows('<!-- one -->\ntext\n<!--\nmulti\n-->\nmore'), ['text', ' ', 'more'])
  assert.deepEqual(rows('<!-- note --> **Keep me**'), ['Keep me'])
  // Comments inside code stay
  assert.equal(parse('```html\n<!-- keep -->\n```')[0].src, '<!-- keep -->')
})

test('front matter needs content on line 2', () => {
  assert.deepEqual(parse('---\ntitle: x\n---\n# H').map((b) => b.type), ['code', 'heading'])
  assert.deepEqual(parse('---\n\nintro\n\n---\n\nend').map((b) => b.type), ['rule', 'para', 'rule', 'para'])
})

test('indented code, but not inside a list', () => {
  assert.deepEqual(parse('text\n\n    a = 1\n\n    b = 2\n\nafter'), [
    { type: 'para', text: 'text' },
    { type: 'code', lang: '', src: 'a = 1\n\nb = 2' },
    { type: 'para', text: 'after' },
  ])
  assert.deepEqual(parse('1. a\n\n    more\n\n    again').map((b) => b.type), ['item', 'para', 'para'])
  // An indented fence (MkDocs tabs) keeps its language
  assert.deepEqual(parse('=== "Tab"\n\n    ```python\n    x = 1\n    ```'), [
    { type: 'para', text: '=== "Tab"' },
    { type: 'code', lang: 'python', src: 'x = 1' },
  ])
  assert.deepEqual(parse('!!! note\n\n    Body text.').map((b) => b.type), ['para', 'para'])
})

test('a wrapped line starting with a number other than 1 stays in the paragraph', () => {
  assert.deepEqual(parse('[7] Amdahl, G. M. "Validity",\n    30:483–485,\n    1967. The bound.'), [
    { type: 'para', text: '[7] Amdahl, G. M. "Validity", 30:483–485, 1967. The bound.' },
  ])
  assert.deepEqual(parse('text\n1. first').map((b) => b.type), ['para', 'item'])
  assert.deepEqual(parse('1. a\n2. b').map((b) => b.type), ['item', 'item'])
})

test('list depth follows indent levels, not spaces / 2', () => {
  const depths = (md) => parse(md).map((b) => b.depth)
  assert.deepEqual(depths('- a\n    - b\n        - c\n    - d\n- e'), [0, 1, 2, 1, 0])
  assert.deepEqual(depths('1. a\n   - b'), [0, 1])
  assert.deepEqual(depths('- a\n\npara\n\n    - code?'), [0, undefined, undefined])
})

test('tables still render', () => {
  assert.deepEqual(rows('a | b\n--|--\n1 | 2'), ['┌───┬───┐', '│ a │ b │', '├───┼───┤', '│ 1 │ 2 │', '└───┴───┘'])
})
