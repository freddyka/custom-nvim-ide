# devbox nvim keymaps

The Windows-style, **modeless** keymaps I use in the editor cell (Neovim / AstroNvim).
Copy/cut/paste land you back in insert mode, so it feels like a normal editor while
keeping all of Vim underneath.

## Install

Drop both files into your AstroNvim plugins folder:

```
~/.config/nvim/lua/plugins/
```

| file | what it does |
|---|---|
| `beginner-keymaps.lua` | the keybindings (save, run, copy/paste, comment, buffers, …) |
| `blink-arrows.lua` | completion behaviour: arrows navigate code, **Tab** engages the popup |
| `devbox-session.lua` | in the devbox app's editor cell, auto-restores the last open files on launch and saves them on exit (scoped via the `DEVBOX_EDIT=1` env var the app sets, so your other Neovim instances are untouched) |

Restart Neovim — that's it. (AstroNvim auto-loads anything in `lua/plugins/`.)

## Keybindings

| key | action |
|---|---|
| `Ctrl+S` | save |
| `F5` | run the current file (python, js, ts, c, c++, rust, go, lua, sh, …) |
| `Ctrl+F` | find |
| `Ctrl+G` | start a selection from insert · press again to cancel it |
| `Ctrl+A` | select all |
| `Ctrl+Y` | copy *(returns to insert)* |
| `Ctrl+C` | cut *(returns to insert)* |
| `Ctrl+P` | paste |
| `Ctrl+K` | comment the selection |
| `Del` / `Backspace` | delete the selection |
| `Ctrl+Z` | undo · in insert: `Ctrl+U` undo, `Ctrl+R` redo |
| `Ctrl+→` / `Ctrl+←` | next / previous buffer |
| `Space e` | toggle the file explorer |
| `Esc` / `q` | close a terminal pane (also restored ones) |

### Completion (blink.cmp)

| key | action |
|---|---|
| `↑ ↓ ← →` | navigate the **code** — the popup is ignored |
| `Tab` | step **into** the popup / next suggestion |
| `↑ ↓` (after Tab) | move through suggestions |
| `Tab` again / `Enter` | insert the selected suggestion |
