-- devbox-session.lua
-- Im edit-Pane der devbox-App (gestartet mit DEVBOX_EDIT=1) werden die zuletzt
-- offenen Dateien beim Start automatisch wiederhergestellt und beim Beenden
-- gespeichert. Andere nvim-Instanzen (devbox-Session, codex-test, lokal) bleiben
-- voellig unberuehrt -- es wird nur eine eigene Sitzung "devbox-edit" genutzt.
local NAME = "devbox-edit"

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
            end)
          end,
        },
        {
          event = "VimLeavePre",
          desc = "devbox: Editor-Sitzung speichern",
          callback = function()
            if vim.env.DEVBOX_EDIT ~= "1" then return end
            pcall(function() require("resession").save(NAME, { notify = false }) end)
          end,
        },
      },
    },
  },
}
