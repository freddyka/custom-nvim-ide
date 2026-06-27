-- Vorschlaege (blink.cmp) erscheinen automatisch, stoeren aber nicht:
--  * Pfeiltasten (Up/Down/Left/Right) navigieren IMMER im Code, nicht im Popup.
--  * Mit TAB steigt man ins Popup ein (waehlt den naechsten Vorschlag).
--  * Ist man drin (etwas ausgewaehlt), kann man mit Up/Down weiter auswaehlen.
--  * Mit nochmal TAB oder ENTER wird der Vorschlag eingefuegt.
--  * Strg+P bleibt zum Einfuegen frei.
return {
  "saghen/blink.cmp",
  opts = function(_, opts)
    opts.completion = opts.completion or {}
    opts.completion.menu = opts.completion.menu or {}
    opts.completion.menu.auto_show = true
    opts.completion.ghost_text = opts.completion.ghost_text or {}
    opts.completion.ghost_text.enabled = false
    opts.completion.list = opts.completion.list or {}
    opts.completion.list.selection = { preselect = false, auto_insert = false }

    -- Up/Down navigieren nur dann im Popup, wenn es offen ist UND schon etwas
    -- ausgewaehlt wurde (also nachdem man Tab gedrueckt hat). Sonst: Cursor im Code.
    local function nav(cmd)
      return function(cmp)
        local ok_v, vis = pcall(function() return cmp.is_visible() end)
        local ok_s, sel = pcall(function() return cmp.get_selected_item() end)
        if ok_v and vis and ok_s and sel ~= nil then
          return cmp[cmd]()
        end
      end
    end

    opts.keymap = opts.keymap or {}
    opts.keymap.preset = "none"
    opts.keymap["<Up>"] = { nav("select_prev"), "fallback" }
    opts.keymap["<Down>"] = { nav("select_next"), "fallback" }
    opts.keymap["<Left>"] = { "fallback" }
    opts.keymap["<Right>"] = { "fallback" }
    opts.keymap["<Tab>"] = { "select_next", "fallback" }
    opts.keymap["<S-Tab>"] = { "select_prev", "fallback" }
    opts.keymap["<CR>"] = { "accept", "fallback" }
    opts.keymap["<C-Space>"] = { "show", "fallback" }
    opts.keymap["<C-e>"] = { "hide", "fallback" }
    opts.keymap["<C-p>"] = { "fallback" }
    opts.keymap["<C-P>"] = { "fallback" }

    return opts
  end,
}
