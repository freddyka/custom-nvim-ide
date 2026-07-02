-- devbox-session.lua
-- Im edit-Pane der devbox-App (DEVBOX_EDIT=1) werden die zuletzt offenen Dateien beim
-- Start wiederhergestellt und beim Beenden gespeichert. Beim Laden/Speichern werden
-- aufgeraeumt: neo-tree-Fenster/-Buffer (sonst leerer Baum nach Restore) UND "Ghost"-
-- Buffer, deren Datei es nicht mehr gibt (z.B. nach einem Ordner-Umbenennen) -- die
-- lassen sonst neo-tree mit ENOENT abstuerzen. Andere nvim-Instanzen bleiben unberuehrt.
local NAME = "devbox-edit"

local function cleanup()
  pcall(function() require("neo-tree.command").execute({ action = "close" }) end)
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(b) then
      local name = vim.api.nvim_buf_get_name(b)
      if vim.bo[b].filetype == "neo-tree" then
        pcall(vim.api.nvim_buf_delete, b, { force = true }) -- neo-tree nie mitspeichern/wiederherstellen
      elseif vim.bo[b].buftype == "" and name ~= "" and not vim.bo[b].modified and vim.fn.filereadable(name) == 0 then
        pcall(vim.api.nvim_buf_delete, b, { force = true }) -- Ghost: Datei existiert nicht mehr
      end
    end
  end
end

return {
  "AstroNvim/astrocore",
  opts = {
    autocmds = {
      devbox_session = {
        {
          event = "VimEnter",
          nested = true,
          desc = "devbox: letzte Editor-Sitzung laden",
          callback = function()
            if vim.env.DEVBOX_EDIT ~= "1" then return end
            if vim.fn.argc() ~= 0 then return end -- nur ohne Datei-Argumente
            vim.schedule(function()
              pcall(function() require("resession").load(NAME, { silence_errors = true }) end)
              cleanup()
            end)
          end,
        },
        {
          event = "VimLeavePre",
          desc = "devbox: Editor-Sitzung speichern",
          callback = function()
            if vim.env.DEVBOX_EDIT ~= "1" then return end
            cleanup()
            pcall(function() require("resession").save(NAME, { notify = false }) end)
          end,
        },
      },
    },
  },
}
