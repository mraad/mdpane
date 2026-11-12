# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`mdpane` is a Claude Code mod (plugin). It adds the `/mdpane [file.md]` command, which opens a pane that renders a Markdown file with color and formatting and re-reads it every second while "follow" is on. Pane keys: `r` reload, `m` styled/native toggle, `f` follow on/off, Esc close.

No build step, no dependencies, no Git repo. The mod is three files, plus parser tests:

- `.claude-plugin/plugin.json`: plugin manifest (name, version).
- `hooks/hooks.json`: lists the hooks module (`./register.js`).
- `hooks/register.js`: all logic. It exports `register(on)`, and `parse`/`layout` for the tests.
- `tests/render.test.mjs`: `node:test` cases for the renderer. `tests/load.test.mjs`: drives `register(on)` with a fake `$` to test file switching. Node 22+ loads the ESM file without a `package.json`.

For the mods API (`$.ui`, `$.fs`, `$.store`, `$.clock`, `$.command`, hook events, UI elements), load the `plugin-authoring` skill rather than guessing.

## Check

```sh
node --check hooks/register.js            # syntax only
node --test tests/                        # all tests
node --test --test-name-pattern=setext tests/   # one test
```

Pane, keys, timer and file reads are not covered; they can only be verified by loading the mod in Claude Code and running `/mdpane <file>`.

## Constraints

- The hooks module has no Node.js APIs. Use plain JavaScript plus `$`. File reads go through `$.fs.read`, persistence through `$.store`, timers through `$.clock.every`.
- Markdown, Code and single Text elements are capped at 10,000 chars, so `LIMIT = 9000`. Long content must be split (`pieces()` for styled code blocks, `nativeChunks()` for native mode, which never cuts inside a code fence).
- Register the slash command last in `session.start`: a refused name throws and would skip the rest of the hook.
- Module state (`path`, `text`, ...) is lost on module reload. The `ui.render` hook re-reads the file when `text === null`, and `session.start` restores `path` from `$.store`.

## Rendering pipeline (styled mode)

`parse(src)` produces blocks (heading incl. setext, para, item, quote, table, fenced/indented code, rule; HTML comment blocks are dropped; YAML front matter becomes a code block). List depth comes from a stack of open indents; while inside a list or a MkDocs block (`=== "Tab"`, `!!! note`), a 4-space indent continues it rather than starting code. Only a list starting at 1 may interrupt a paragraph. Then `layout(blocks, width)` produces rows, and the `ui.render` hook maps rows to elements.

- A row is either `{ spans }` (one line of styled text spans) or `{ code, lang }` (rendered by the `Code` element with syntax colors). Fenced code without a language becomes plain colored span rows.
- `inline()` turns inline Markdown into spans with one regex (`INLINE`); the numbered capture groups are documented above it. Changing the regex means renumbering the `m[n]` branches.
- `wrap()` does word wrap per width; `fit()` pads or truncates table cells. Width counts code points, so wide CJK/emoji can overflow.
- Rows with `isOneLine` render with `wrap: 'truncate-end'` (rules, table borders, code lines).
- Layout is cached on `(text, width)`; only the first `MAX_ROWS` (3000) rows are drawn.
- Colors live in the `C` table at the top of the file.

Native mode skips all of this and passes chunks to the built-in `Markdown` element.
