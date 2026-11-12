# mdpane

A Claude Code mod that shows a Markdown file in a pane beside the chat. The pane draws headings, lists, tables, quotes and code in color. It reads the file again every second, so edits show up while you or Claude write.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install mdpane --marketplace mraad/mdpane
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```sh
claude plugin install mdpane --marketplace mraad/mdpane
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `mraad/mdpane`, then Add plugin.

To work on the mod, install it from a local clone instead. Claude Code then reads it from that folder, and `/reload-plugins` picks up your edits:

```sh
claude plugin marketplace add /path/to/mdpane
claude plugin install mdpane@mdpane --scope user
```

To remove it:

```sh
claude plugin uninstall mdpane@mdpane
claude plugin marketplace remove mdpane
```

## Use

```
/mdpane docs/plan.md    open a file, or switch to it
/mdpane                 open the last file again
```

Press Ctrl+X, then Tab, to give the pane focus. Then use these keys:

| Key | Action |
| --- | --- |
| `r` | Read the file again |
| `m` | Switch between the styled view and Claude Code's own Markdown view |
| `f` | Turn follow (read every second) on or off |
| Up / Down | Scroll |
| Esc | Close the pane |

The last file is kept across sessions.

## What the styled view draws

- ATX (`#`) and setext (`===` / `---`) headings
- Bold, italic, strikethrough, inline code, links, autolinks and images (shown as `[image: alt]`)
- Bullet, numbered and task lists, nested by indent
- Tables with column alignment
- Block quotes
- Fenced code, with syntax colors when it names a language, and code indented 4 spaces
- YAML front matter, shown as a code block

HTML comments are hidden. Other HTML shows as text.

## Limits

- The styled view draws the first 3,000 rows. Press `m` for the full file in the native view.
- Wide characters (CJK, most emoji) count as one column, so lines that hold them can run past the pane edge.
- Reference-style links (`[text][ref]`) show as text.

## Test

Needs Node 22 or later.

```sh
node --test tests/
```
