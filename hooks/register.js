// mdpane: render a Markdown file in a Claude Code pane.
//
//   /mdpane docs/plan.md    open (or switch to) a file
//   /mdpane                 reopen the last file
//
// Keys while the pane has focus: r reload, m styled/native, f follow on/off,
// Up/Down scroll, Esc close. Ctrl+X then Tab gives the pane focus.
//
// The hooks module has no Node.js APIs, so everything here is plain
// JavaScript plus the mods API ($).

const PANE = 'mdpane'
const CMD = 'mdpane'
const POLL_MS = 1000 // how often a followed file is re-read
const LIMIT = 9000 // Markdown, Code and one Text string are capped at 10,000 chars
const MAX_ROWS = 3000 // styled rows drawn before the view is cut off

// Text colors. Swap for theme keys or other color names your build accepts.
const C = {
  h1: 'magenta',
  h2: 'cyan',
  h3: 'yellow',
  h4: 'green',
  code: 'yellow',
  link: 'blue',
  quote: 'green',
  bullet: 'cyan',
  tableHead: 'cyan',
  done: 'green',
  error: 'red',
}

// ---------------------------------------------------------------- state

let path = null // file being shown
let text = null // its content, or null before the first read
let error = null // last read error, as a string
let mode = 'styled' // 'styled' (this file's renderer) or 'native' (Markdown element)
let follow = true // re-read the file on a timer
let isOpen = false
let isLoading = false
let cache = { text: null, width: 0, rows: [] }

// ---------------------------------------------------------------- inline

// 1 ticks, 2 code, 3 bold+italic, 4 bold *, 5 bold _, 6 strike, 7 em *, 8 em _,
// 9 image bang, 10 link label, 11 link url, 12 autolink, 13 escaped char
const INLINE =
  /(`+)(.+?)\1(?!`)|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^\s*](?:.*?[^\s*])?)\*|(?<![A-Za-z0-9])_([^\s_](?:.*?[^\s_])?)_(?![A-Za-z0-9])|(!?)\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<((?:https?|mailto):[^>\s]+)>|\\([\\`*_{}[\]()#+\-.!~|>])/g

// Turn inline Markdown into styled spans: [{ t, bold, italic, color, ... }]
function inline(src, st = {}) {
  const out = []
  let last = 0
  for (const m of src.matchAll(INLINE)) {
    if (m.index > last) out.push({ ...st, t: src.slice(last, m.index) })
    last = m.index + m[0].length
    if (m[2] !== undefined) out.push({ ...st, color: C.code, t: m[2] })
    else if (m[3] !== undefined) out.push(...inline(m[3], { ...st, bold: true, italic: true }))
    else if (m[4] !== undefined) out.push(...inline(m[4], { ...st, bold: true }))
    else if (m[5] !== undefined) out.push(...inline(m[5], { ...st, bold: true }))
    else if (m[6] !== undefined) out.push(...inline(m[6], { ...st, strikethrough: true, dimColor: true }))
    else if (m[7] !== undefined) out.push(...inline(m[7], { ...st, italic: true }))
    else if (m[8] !== undefined) out.push(...inline(m[8], { ...st, italic: true }))
    else if (m[11] !== undefined) {
      if (m[9]) out.push({ ...st, dimColor: true, t: '[image: ' + (m[10] || m[11]) + ']' })
      else {
        out.push(...inline(m[10] || m[11], { ...st, color: C.link, underline: true }))
        if (m[10] && m[10] !== m[11]) out.push({ ...st, dimColor: true, t: ' (' + m[11] + ')' })
      }
    } else if (m[12] !== undefined) out.push({ ...st, color: C.link, underline: true, t: m[12] })
    else if (m[13] !== undefined) out.push({ ...st, t: m[13] })
  }
  if (last < src.length) out.push({ ...st, t: src.slice(last) })
  return out
}

// ---------------------------------------------------------------- blocks

const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^ {0,3}>/
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const SETEXT = /^ {0,3}(=+|-+)\s*$/
const COMMENT = /^ {0,3}<!--/
const LATE_NUM = /^\s*(?:[2-9]|\d{2,})[.)]\s/ // only a list starting at 1 may interrupt a paragraph
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

function isTable(lines, i) {
  if (!lines[i].includes('|') || i + 1 >= lines.length) return false
  if (!DELIM.test(lines[i + 1])) return false
  return splitRow(lines[i]).length === splitRow(lines[i + 1]).length
}

const startsBlock = (lines, i) =>
  FENCE.test(lines[i]) ||
  HEADING.test(lines[i]) ||
  RULE.test(lines[i]) ||
  QUOTE.test(lines[i]) ||
  ITEM.test(lines[i]) ||
  COMMENT.test(lines[i]) ||
  isTable(lines, i)

// Turn Markdown source into a list of blocks
function parse(src, isTop = true) {
  const lines = src.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
  const blocks = []
  let i = 0

  // YAML front matter, shown as a code block
  if (isTop && lines[0] === '---' && lines[1]?.trim()) {
    const end = lines.indexOf('---', 1)
    if (end > 0) {
      blocks.push({ type: 'code', lang: 'yaml', src: lines.slice(1, end).join('\n') })
      i = end + 1
    }
  }

  let inList = false // inside a list, a 4-space indent continues an item, not code
  let indents = [] // indents of the open list levels

  while (i < lines.length) {
    const line = lines[i]
    let m
    if (line.trim() && !/^\s/.test(line) && !ITEM.test(line)) {
      inList = false
      indents = []
    }
    // MkDocs tabs and admonitions indent their body 4 spaces, like a list item
    if (/^(?:===|!!!|\?\?\?\+?) /.test(line)) inList = true
    if (!line.trim()) {
      i++
    } else if (COMMENT.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++
      // Text after the comment on its closing line stays
      const rest = i < lines.length ? lines[i].slice(lines[i].indexOf('-->') + 3) : ''
      if (rest.trim()) lines[i] = rest
      else i++
    } else if (!inList && line.startsWith('    ') && !FENCE.test(line)) {
      const body = []
      while (i < lines.length && (lines[i].startsWith('    ') || !lines[i].trim())) body.push(lines[i++].slice(4))
      while (!body[body.length - 1].trim()) body.pop()
      blocks.push({ type: 'code', lang: '', src: body.join('\n') })
    } else if ((m = line.match(FENCE))) {
      const indent = line.length - line.trimStart().length
      const close = new RegExp('^\\s*' + m[1][0] + '{' + m[1].length + ',}\\s*$')
      const body = []
      i++
      while (i < lines.length && !close.test(lines[i])) {
        const l = lines[i++]
        body.push(l.slice(Math.min(indent, l.length - l.trimStart().length)))
      }
      i++
      blocks.push({ type: 'code', lang: m[2], src: body.join('\n') })
    } else if ((m = line.match(HEADING))) {
      blocks.push({ type: 'heading', level: m[1].length, text: m[2] })
      i++
    } else if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      i++
    } else if (QUOTE.test(line)) {
      const inner = []
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ''))
      blocks.push({ type: 'quote', blocks: parse(inner.join('\n'), false) })
    } else if (isTable(lines, i)) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
      )
      const rows = []
      i += 2
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]))
      blocks.push({ type: 'table', head, align, rows })
    } else if ((m = line.match(ITEM))) {
      inList = true
      while (indents.length && indents[indents.length - 1] >= m[1].length) indents.pop()
      const depth = Math.min(indents.length, 8)
      indents.push(m[1].length)
      let body = m[3]
      i++
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) body += ' ' + lines[i++].trim()
      const task = body.match(/^\[([ xX])\]\s+(.*)$/)
      blocks.push({
        type: 'item',
        depth,
        marker: m[2],
        task: task ? task[1] !== ' ' : null,
        text: task ? task[2] : body,
      })
    } else {
      const para = [line.trim()]
      i++
      while (
        i < lines.length &&
        lines[i].trim() &&
        !SETEXT.test(lines[i]) &&
        (!startsBlock(lines, i) || LATE_NUM.test(lines[i]))
      )
        para.push(lines[i++].trim())
      const sx = i < lines.length && lines[i].match(SETEXT)
      if (sx) i++
      blocks.push(sx ? { type: 'heading', level: sx[1][0] === '=' ? 1 : 2, text: para.join(' ') } : { type: 'para', text: para.join(' ') })
    }
  }
  return blocks
}

// ---------------------------------------------------------------- layout

// Length in code points. Wide characters (CJK, most emoji) count as one cell,
// so lines that hold them can run past the pane's edge.
const len = (s) => [...s].length
const spanLen = (spans) => spans.reduce((n, s) => n + len(s.t), 0)

const STYLE_KEYS = ['color', 'backgroundColor', 'bold', 'italic', 'underline', 'strikethrough', 'dimColor', 'inverse']
function style(s) {
  const out = {}
  for (const k of STYLE_KEYS) if (s[k]) out[k] = s[k]
  return out
}

// Join neighbouring spans that share a style, and drop empty ones
function merge(spans) {
  const out = []
  for (const s of spans) {
    if (!s.t) continue
    const prev = out[out.length - 1]
    if (prev && JSON.stringify(style(prev)) === JSON.stringify(style(s))) prev.t += s.t
    else out.push({ ...s })
  }
  return out.length ? out : [{ t: ' ' }]
}

// Word-wrap spans to a width. `first` starts the first line, `rest` the others.
function wrap(spans, width, first = [], rest = first) {
  const out = []
  let cur = [...first]
  let used = spanLen(first)
  let hasWord = false
  let space = null
  const flush = () => {
    out.push({ spans: merge(cur) })
    cur = [...rest]
    used = spanLen(rest)
    hasWord = false
    space = null
  }
  for (const s of spans) {
    for (const tok of s.t.split(/(\s+)/)) {
      if (!tok) continue
      if (/^\s+$/.test(tok)) {
        if (hasWord) space = { ...s, t: ' ' }
        continue
      }
      let word = tok
      if (hasWord && used + len(word) + (space ? 1 : 0) > width) flush()
      if (space) {
        cur.push(space)
        used++
        space = null
      }
      // A word longer than a whole line is cut across lines
      let room = Math.max(1, width - used)
      while (len(word) > room) {
        const cp = [...word]
        cur.push({ ...s, t: cp.slice(0, room).join('') })
        word = cp.slice(room).join('')
        flush()
        room = Math.max(1, width - used)
      }
      cur.push({ ...s, t: word })
      used += len(word)
      hasWord = true
    }
  }
  if (hasWord || !out.length) out.push({ spans: merge(cur) })
  return out
}

// Cut or pad spans to exactly `width` cells
function fit(spans, width, align) {
  const out = []
  let used = 0
  const total = spanLen(spans)
  for (const s of spans) {
    const room = width - used - (total > width ? 1 : 0)
    if (room <= 0) break
    const t = [...s.t].slice(0, room).join('')
    out.push({ ...s, t })
    used += len(t)
  }
  if (total > width) {
    out.push({ t: '…', dimColor: true })
    used++
  }
  const pad = Math.max(0, width - used)
  const left = align === 'right' ? pad : align === 'center' ? Math.floor(pad / 2) : 0
  return [{ t: ' '.repeat(left) }, ...out, { t: ' '.repeat(pad - left) }]
}

function tableRows(b, width) {
  const n = b.head.length
  const grid = [b.head, ...b.rows].map((r, y) =>
    b.head.map((_, c) => inline(r[c] ?? '', y === 0 ? { bold: true, color: C.tableHead } : {})),
  )
  const w = b.head.map((_, c) => Math.max(1, ...grid.map((r) => spanLen(r[c]))))
  const over = () => w.reduce((a, x) => a + x, 0) + 3 * n + 1 - width
  // Narrow the widest column until the table fits
  while (over() > 0) {
    const k = w.indexOf(Math.max(...w))
    if (w[k] <= 3) break
    w[k]--
  }
  const line = (l, mid, r) => ({
    isOneLine: true,
    spans: [{ dimColor: true, t: l + w.map((x) => '─'.repeat(x + 2)).join(mid) + r }],
  })
  const row = (cells) => {
    const spans = [{ dimColor: true, t: '│ ' }]
    cells.forEach((cell, c) => {
      spans.push(...fit(cell, w[c], b.align[c]))
      spans.push({ dimColor: true, t: c === n - 1 ? ' │' : ' │ ' })
    })
    return { isOneLine: true, spans: merge(spans) }
  }
  return [line('┌', '┬', '┐'), row(grid[0]), line('├', '┼', '┤'), ...grid.slice(1).map(row), line('└', '┴', '┘')]
}

// Split text into pieces under the size cap, on line breaks
function pieces(src) {
  const out = []
  let cur = []
  let size = 0
  for (const raw of src.split('\n')) {
    const line = raw.length > LIMIT ? raw.slice(0, LIMIT) : raw
    if (cur.length && size + line.length + 1 > LIMIT) {
      out.push(cur.join('\n'))
      cur = []
      size = 0
    }
    cur.push(line)
    size += line.length + 1
  }
  if (cur.length) out.push(cur.join('\n'))
  return out
}

const BLANK = { spans: [{ t: ' ' }] }
const HEAD = [
  null,
  { bold: true, underline: true, color: C.h1 },
  { bold: true, color: C.h2 },
  { bold: true, color: C.h3 },
  { bold: true, color: C.h4 },
  { bold: true },
  { bold: true, dimColor: true },
]
const BULLETS = ['•', '◦', '▪']

// Turn blocks into rows. A row is { spans } or { code, lang }.
function layout(blocks, width) {
  const rows = []
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1]
    if (prev && !(prev.type === 'item' && b.type === 'item')) rows.push(BLANK)
    if (b.type === 'heading') {
      rows.push(...wrap(inline(b.text, HEAD[b.level]), width))
      if (b.level === 1) rows.push({ isOneLine: true, spans: [{ color: C.h1, t: '━'.repeat(width) }] })
    } else if (b.type === 'para') {
      rows.push(...wrap(inline(b.text), width))
    } else if (b.type === 'item') {
      const indent = '  '.repeat(b.depth)
      const mark =
        b.task === true
          ? { color: C.done, t: indent + '☑ ' }
          : b.task === false
            ? { dimColor: true, t: indent + '☐ ' }
            : { color: C.bullet, t: indent + (/\d/.test(b.marker) ? b.marker : BULLETS[b.depth % 3]) + ' ' }
      const body = inline(b.text, b.task === true ? { dimColor: true, strikethrough: true } : {})
      rows.push(...wrap(body, width, [mark], [{ t: ' '.repeat(len(mark.t)) }]))
    } else if (b.type === 'quote') {
      for (const r of layout(b.blocks, Math.max(10, width - 2)))
        rows.push(r.spans ? { ...r, spans: [{ color: C.quote, t: '▌ ' }, ...r.spans] } : r)
    } else if (b.type === 'rule') {
      rows.push({ isOneLine: true, spans: [{ dimColor: true, t: '─'.repeat(width) }] })
    } else if (b.type === 'table') {
      rows.push(...tableRows(b, width))
    } else if (b.type === 'code') {
      // With a language, Claude Code colors the syntax. Without one, plain colored lines.
      if (b.lang) for (const p of pieces(b.src)) rows.push({ code: p, lang: b.lang })
      else
        for (const l of b.src.split('\n'))
          rows.push({ isOneLine: true, spans: [{ color: C.code, t: '  ' + (l.slice(0, LIMIT) || ' ') }] })
    }
  })
  return rows
}

// Split a document for the native Markdown element, never inside a code fence
function nativeChunks(src) {
  const out = []
  let cur = []
  let size = 0
  let fence = null
  const cut = () => {
    if (fence) cur.push(fence.close)
    out.push(cur.join('\n'))
    cur = fence ? [fence.open] : []
    size = fence ? fence.open.length + 1 : 0
  }
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.length > LIMIT / 2 ? raw.slice(0, LIMIT / 2) : raw
    if (cur.length && size + line.length + 1 > LIMIT - 20) cut()
    cur.push(line)
    size += line.length + 1
    const m = line.match(FENCE)
    if (m && !fence) fence = { open: line, close: m[1] }
    else if (fence && line.trim().startsWith(fence.close) && line.trim().replace(/[`~]/g, '') === '') fence = null
    else if (!fence && !line.trim() && size > LIMIT * 0.6) cut()
  }
  if (cur.length) cut()
  return out.filter((c) => c.trim())
}

// ---------------------------------------------------------------- file

// Read the file. Resolves to true when what the pane shows has changed.
async function load($) {
  if (!path || isLoading) return false
  isLoading = true
  const p = path
  let r, err
  try {
    r = await $.fs.read(p)
  } catch (e) {
    err = e ?? 'read failed'
  } finally {
    isLoading = false
  }
  // The path changed during the read (a load for the new path was skipped): drop this result, read the new file
  if (p !== path) return load($)
  if (err !== undefined) {
    const msg = String(err?.message ?? err)
    const changed = msg !== error
    error = msg
    return changed
  }
  // Accept a string, or an object that carries the text
  const t = typeof r === 'string' ? r : String(r?.text ?? r?.content ?? '')
  const changed = t !== text || error !== null
  text = t
  error = null
  return changed
}

export { parse, layout }

const baseName = (p) => p.split(/[\\/]/).pop() || p

// ---------------------------------------------------------------- hooks

export function register(on) {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('path')
    if (!path && typeof saved === 'string') path = saved
    // Re-read a followed file, and redraw only when it changed
    $.clock.every(POLL_MS, async () => {
      if (!isOpen || !follow || !path) return
      if (await load($)) $.ui.invalidate('ui.render')
    })
    // Registered last: a refused name throws, and a throw skips the rest of the hook
    try {
      await $.command.register({
        name: CMD,
        description: 'Show a Markdown file in a pane, with color and formatting',
        argumentHint: '[file.md]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log('could not add /' + CMD + ': ' + String(err?.message ?? err))
    }
    return next(e)
  })

  on('command.run', { command: CMD }, async ($, e) => {
    const arg = String(e.args || '')
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2')
    if (arg && arg !== path) {
      path = arg
      text = null
      error = null
      await $.store.set('path', path)
    }
    if (!path) {
      $.ui.toast('Usage: /' + CMD + ' <file.md>')
      return {}
    }
    await load($)
    isOpen = true
    await $.ui.open({ id: PANE, title: baseName(path), focus: true, closeOnEscape: true })
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const E = $.ui.resolve(e)
    const { Box, Text, Button, Markdown, Code } = E
    const redraw = () => $.ui.invalidate('ui.render')
    isOpen = true

    // After a module reload the content is gone, so read it again
    if (path && text === null && error === null && !isLoading) load($).then(redraw, redraw)

    const width = Math.max(24, Number(e.props?.bodyColumns ?? 80) - 1)

    const bar = Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Button({
          key: 'reload',
          label: 'reload',
          hotkey: 'r',
          plain: true,
          onPress: async () => {
            await load($)
            redraw()
          },
        }),
        Button({
          key: 'mode',
          label: mode,
          hotkey: 'm',
          plain: true,
          onPress: () => {
            mode = mode === 'styled' ? 'native' : 'styled'
            redraw()
          },
        }),
        Button({
          key: 'follow',
          label: follow ? 'follow on' : 'follow off',
          hotkey: 'f',
          plain: true,
          dimColor: !follow,
          onPress: () => {
            follow = !follow
            redraw()
          },
        }),
      ],
    })

    const head = [bar, Text({ dimColor: true, wrap: 'truncate-middle', children: [path || 'no file'] })]

    let body
    if (error) body = [Text({ color: C.error, children: ['Could not read ' + path + ': ' + error.slice(0, 500)] })]
    else if (!path) body = [Text({ children: ['Run /' + CMD + ' <file.md> to show a file.'] })]
    else if (text === null) body = [Text({ dimColor: true, children: ['Loading…'] })]
    else if (!text.trim()) body = [Text({ dimColor: true, children: ['The file is empty.'] })]
    else if (mode === 'native') body = nativeChunks(text).map((t, i) => Markdown({ key: 'md-' + i, text: t }))
    else {
      if (cache.text !== text || cache.width !== width) cache = { text, width, rows: layout(parse(text), width) }
      const rows = cache.rows.slice(0, MAX_ROWS)
      body = rows.map((row) => {
        if (row.code !== undefined)
          return Box({ borderStyle: 'round', paddingX: 1, children: [Code({ language: row.lang, source: row.code })] })
        const extra = row.isOneLine ? { wrap: 'truncate-end' } : {}
        const texts = row.spans.map((s) => Text({ ...style(s), ...extra, children: [s.t] }))
        return texts.length === 1 ? texts[0] : Box({ flexDirection: 'row', children: texts })
      })
      if (cache.rows.length > MAX_ROWS)
        body.push(Text({ dimColor: true, children: ['… ' + (cache.rows.length - MAX_ROWS) + ' more rows not shown. Press m for the native view.'] }))
    }

    return Box({ flexDirection: 'column', children: [...head, Text({ children: [' '] }), ...body] })
  })
}
