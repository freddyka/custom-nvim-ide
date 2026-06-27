-- Custom devbox keymaps (Windows-style, modeless: copy/cut/paste return to insert).
-- Loaded automatically by AstroNvim (any file in lua/plugins/).
-- NOTE: keycodes follow vimdoc casing; <Leader> = Space.

local function run_file()
  vim.cmd("silent! write")
  local ft = vim.bo.filetype
  local runners = {
    python = "python3 %s",
    lua = "lua %s",
    sh = "bash %s",
    bash = "bash %s",
    zsh = "bash %s",
    javascript = "node %s",
    javascriptreact = "node %s",
    typescript = "ts-node %s",
    typescriptreact = "ts-node %s",
    c = "cc %s -o /tmp/devbox_run && /tmp/devbox_run",
    cpp = "c++ %s -o /tmp/devbox_run && /tmp/devbox_run",
    rust = "rustc %s -o /tmp/devbox_run && /tmp/devbox_run",
    go = "go run %s",
    java = "java %s",
    ruby = "ruby %s",
    php = "php %s",
    perl = "perl %s",
  }
  local tmpl = runners[ft]
  if not tmpl then
    vim.notify("F5: kein Runner fuer filetype '" .. ft .. "'", vim.log.levels.WARN)
    return
  end
  local cmd = string.format(tmpl, vim.fn.shellescape(vim.fn.expand("%:p")))
  vim.cmd("botright 15split | terminal " .. cmd)
  vim.cmd("startinsert")
end

-- Terminal-Buffer mit Esc/q schliessen -- auch wiederhergestellte aus alten Sessions.
local function setup_term_close(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return end
  if vim.bo[buf].buftype ~= "terminal" then return end
  if vim.bo[buf].filetype == "toggleterm" then return end -- lazygit/toggleterm in Ruhe lassen
  if vim.b[buf].devbox_term_close then return end
  vim.b[buf].devbox_term_close = true
  local function close_term()
    pcall(vim.api.nvim_buf_delete, vim.api.nvim_get_current_buf(), { force = true })
    for _, w in ipairs(vim.api.nvim_list_wins()) do
      local wb = vim.api.nvim_win_get_buf(w)
      if vim.bo[wb].buftype == "" and vim.api.nvim_buf_get_name(wb) ~= "" then
        pcall(vim.api.nvim_set_current_win, w)
        break
      end
    end
    if vim.bo.buftype == "" then vim.cmd("startinsert") end
  end
  local o = { buffer = buf, silent = true }
  vim.keymap.set("t", "<Esc>", close_term, o)
  vim.keymap.set("n", "<Esc>", close_term, o)
  vim.keymap.set("n", "q", close_term, o)
end
vim.api.nvim_create_autocmd({ "TermOpen", "BufWinEnter" }, {
  desc = "Esc/q schliesst Terminal-Buffer (auch wiederhergestellte)",
  callback = function(args) setup_term_close(args.buf) end,
})

return {
  "AstroNvim/astrocore",
  opts = function(_, opts)
    -- Kopieren in die System-Zwischenablage ueber SSH (kein X) via OSC52.
    -- Lokal (kitty mit DISPLAY) erkennt nvim xclip automatisch.
    if (vim.env.DISPLAY == nil or vim.env.DISPLAY == "")
      and (vim.env.WAYLAND_DISPLAY == nil or vim.env.WAYLAND_DISPLAY == "") then
      local ok, osc52 = pcall(require, "vim.ui.clipboard.osc52")
      if ok then
        vim.g.clipboard = {
          name = "osc52",
          copy = { ["+"] = osc52.copy("+"), ["*"] = osc52.copy("*") },
          paste = { ["+"] = osc52.paste("+"), ["*"] = osc52.paste("*") },
        }
      end
    end

    opts.mappings = opts.mappings or {}
    local m = opts.mappings
    m.n = m.n or {}
    m.i = m.i or {}
    m.v = m.v or {}
    m.x = m.x or {}

    -- Speichern: Ctrl+S (normal/insert/visual), bleibt im jeweiligen Modus
    m.n["<C-s>"] = { "<Cmd>w<CR>", desc = "Speichern" }
    m.i["<C-s>"] = { "<Cmd>w<CR>", desc = "Speichern" }
    m.v["<C-s>"] = { "<Cmd>w<CR>", desc = "Speichern" }

    -- Datei ausfuehren: F5
    m.n["<F5>"] = { run_file, desc = "Datei ausfuehren" }
    m.i["<F5>"] = { function() vim.cmd("stopinsert") run_file() end, desc = "Datei ausfuehren" }

    -- Im Code suchen: Ctrl+F (auch aus Insert)
    m.n["<C-f>"] = { "/", desc = "Im Code suchen" }
    m.i["<C-f>"] = { "<Esc>/", desc = "Im Code suchen" }

    -- Markieren ab Insert: Ctrl+G -> Visual; nochmal Ctrl+G hebt die Markierung auf (zurueck zu Insert)
    m.i["<C-g>"] = { "<Esc>v", desc = "Markieren (Visual)" }
    m.x["<C-g>"] = { "<Esc>i", desc = "Markierung aufheben" }
    m.v["<C-g>"] = { "<Esc>i", desc = "Markierung aufheben" }

    -- Auswahl auskommentieren: Ctrl+K (nvim-builtin gc)
    m.x["<C-k>"] = { "gc", desc = "Auskommentieren", remap = true }
    m.v["<C-k>"] = { "gc", desc = "Auskommentieren", remap = true }

    -- Auswahl loeschen mit Entf ODER Backspace -> danach wieder Insert (modeless)
    m.x["<Del>"] = { '"_d<Cmd>startinsert<CR>', desc = "Auswahl loeschen" }
    m.v["<Del>"] = { '"_d<Cmd>startinsert<CR>', desc = "Auswahl loeschen" }
    m.x["<BS>"] = { '"_d<Cmd>startinsert<CR>', desc = "Auswahl loeschen" }
    m.v["<BS>"] = { '"_d<Cmd>startinsert<CR>', desc = "Auswahl loeschen" }

    -- Zwischenablage: kopieren=Ctrl+Y, ausschneiden=Ctrl+C, einfuegen=Ctrl+P
    -- Nach Copy/Cut/Paste zurueck in den Insert-Mode (modeless, kein Normal-Mode)
    m.v["<C-y>"] = { '"+y<Cmd>startinsert<CR>', desc = "Kopieren (Zwischenablage)" }
    m.x["<C-y>"] = { '"+y<Cmd>startinsert<CR>', desc = "Kopieren (Zwischenablage)" }
    m.n["<C-y>"] = { '"+yy', desc = "Zeile kopieren" }
    m.v["<C-c>"] = { '"+d<Cmd>startinsert<CR>', desc = "Ausschneiden (Zwischenablage)" }
    m.x["<C-c>"] = { '"+d<Cmd>startinsert<CR>', desc = "Ausschneiden (Zwischenablage)" }
    m.n["<C-c>"] = { '"+dd', desc = "Zeile ausschneiden" }
    m.n["<C-p>"] = { '""p', desc = "Einfuegen (letztes Copy/Cut)" }
    m.v["<C-p>"] = { '"_c<C-r><C-o>"', desc = "Einfuegen ueber Auswahl (zu Insert)" }
    m.x["<C-p>"] = { '"_c<C-r><C-o>"', desc = "Einfuegen ueber Auswahl (zu Insert)" }
    m.i["<C-p>"] = { '<C-r>"', desc = "Einfuegen (letztes Copy/Cut)" }

    -- Alles markieren: Ctrl+A  (ueberschreibt vims Increment-Zahl)
    m.n["<C-a>"] = { "ggVG", desc = "Alles markieren" }
    m.i["<C-a>"] = { "<Esc>ggVG", desc = "Alles markieren" }
    m.v["<C-a>"] = { "<Esc>ggVG", desc = "Alles markieren" }

    -- Undo/Redo: normal = vim-Default (u / Ctrl+R). Insert: Ctrl+U undo, Ctrl+R redo.
    m.i["<C-u>"] = { "<C-o>u", desc = "Undo" }
    m.i["<C-r>"] = { "<C-o><C-r>", desc = "Redo" }
    -- Ctrl+Z = Undo nur im Normal-Mode (verhindert Suspend); im Insert bewusst NICHT gemappt
    m.n["<C-z>"] = { "u", desc = "Undo" }

    -- Buffer wechseln: Ctrl+Rechts / Ctrl+Links (normal + insert; zuverlaessig in kitty + tmux/SSH)
    m.n["<C-Right>"] = { function() require("astrocore.buffer").nav(vim.v.count1) end, desc = "Naechster Buffer" }
    m.n["<C-Left>"] = { function() require("astrocore.buffer").nav(-vim.v.count1) end, desc = "Voriger Buffer" }
    m.i["<C-Right>"] = { function() require("astrocore.buffer").nav(vim.v.count1) end, desc = "Naechster Buffer" }
    m.i["<C-Left>"] = { function() require("astrocore.buffer").nav(-vim.v.count1) end, desc = "Voriger Buffer" }

    return opts
  end,
}
