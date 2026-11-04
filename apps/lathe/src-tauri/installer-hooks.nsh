; Installer additions for Lathe. Tauri's NSIS template runs the NSIS_HOOK_* macros
; (bundle.windows.nsis.installerHooks in tauri.conf.json). Everything here is per-user (HKCU,
; which SHCTX is in a current-user install), and the uninstaller takes it all out again.
;
; - "Open with Lathe" for files, folders and the inside of a folder. On Windows 11 these sit under
;   "Show more options" (the new menu needs a signed app package).
; - Lathe in "Open with" for code files, and in Settings > Apps > Default apps, without taking
;   over any file type: double-clicking a .py file still does what it did. Windows leaves the
;   choice of default app to you.
; - `lathe` on your PATH: bin\lathe.cmd (and bin\lathe for Git Bash). `lathe --wait` makes Lathe
;   usable as Git's editor.

!define LATHE_PROGID "Lathe.File"

; The file types Lathe offers to open (no dot).
!macro LATHE_FILE_TYPES DO
  !insertmacro ${DO} "py"
  !insertmacro ${DO} "pyw"
  !insertmacro ${DO} "pyi"
  !insertmacro ${DO} "ipynb"
  !insertmacro ${DO} "js"
  !insertmacro ${DO} "mjs"
  !insertmacro ${DO} "cjs"
  !insertmacro ${DO} "jsx"
  !insertmacro ${DO} "ts"
  !insertmacro ${DO} "mts"
  !insertmacro ${DO} "cts"
  !insertmacro ${DO} "tsx"
  !insertmacro ${DO} "json"
  !insertmacro ${DO} "jsonc"
  !insertmacro ${DO} "md"
  !insertmacro ${DO} "markdown"
  !insertmacro ${DO} "txt"
  !insertmacro ${DO} "log"
  !insertmacro ${DO} "ini"
  !insertmacro ${DO} "cfg"
  !insertmacro ${DO} "conf"
  !insertmacro ${DO} "toml"
  !insertmacro ${DO} "yaml"
  !insertmacro ${DO} "yml"
  !insertmacro ${DO} "xml"
  !insertmacro ${DO} "html"
  !insertmacro ${DO} "htm"
  !insertmacro ${DO} "css"
  !insertmacro ${DO} "scss"
  !insertmacro ${DO} "less"
  !insertmacro ${DO} "c"
  !insertmacro ${DO} "h"
  !insertmacro ${DO} "cc"
  !insertmacro ${DO} "cpp"
  !insertmacro ${DO} "cxx"
  !insertmacro ${DO} "hpp"
  !insertmacro ${DO} "hh"
  !insertmacro ${DO} "rs"
  !insertmacro ${DO} "go"
  !insertmacro ${DO} "java"
  !insertmacro ${DO} "kt"
  !insertmacro ${DO} "cs"
  !insertmacro ${DO} "fs"
  !insertmacro ${DO} "rb"
  !insertmacro ${DO} "php"
  !insertmacro ${DO} "lua"
  !insertmacro ${DO} "pl"
  !insertmacro ${DO} "sh"
  !insertmacro ${DO} "bash"
  !insertmacro ${DO} "ps1"
  !insertmacro ${DO} "psm1"
  !insertmacro ${DO} "bat"
  !insertmacro ${DO} "cmd"
  !insertmacro ${DO} "sql"
  !insertmacro ${DO} "r"
  !insertmacro ${DO} "dart"
  !insertmacro ${DO} "swift"
  !insertmacro ${DO} "vue"
  !insertmacro ${DO} "svelte"
  !insertmacro ${DO} "csv"
  !insertmacro ${DO} "env"
  !insertmacro ${DO} "gitignore"
  !insertmacro ${DO} "editorconfig"
!macroend

; In "Open with" (OpenWithProgids adds Lathe beside what's there; the type's default stays), and
; in Lathe's Default apps page.
!macro LATHE_ADD_TYPE EXT
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${LATHE_PROGID}" ""
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities\FileAssociations" ".${EXT}" "${LATHE_PROGID}"
!macroend

; Only Lathe's own value goes: the keys may hold other apps' entries.
!macro LATHE_REMOVE_TYPE EXT
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${LATHE_PROGID}"
!macroend

; "Open with Lathe" on a kind of item (KEY: *, Directory, Directory\Background).
!macro LATHE_ADD_VERB KEY ARG
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Lathe" "" "Open with Lathe"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Lathe" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${KEY}\shell\Lathe\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "${ARG}"'
!macroend

; Adds bin to your PATH (-Remove takes it out), then tells running programs.
!macro LATHE_PATH SWITCH
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\bin\lathe-path.ps1" -Dir "$INSTDIR\bin" ${SWITCH}'
  Pop $0
  ; HWND_BROADCAST, WM_SETTINGCHANGE
  SendMessage 0xFFFF 0x001A 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The file type Lathe opens files as.
  WriteRegStr SHCTX "Software\Classes\${LATHE_PROGID}" "" "Code file"
  WriteRegStr SHCTX "Software\Classes\${LATHE_PROGID}\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\${LATHE_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Default apps: start clean, so types an older version listed don't linger.
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}\Capabilities"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationDescription" "A fast, minimal code editor"
  WriteRegStr SHCTX "${MANUPRODUCTKEY}\Capabilities" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  !insertmacro LATHE_FILE_TYPES LATHE_ADD_TYPE
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${MANUPRODUCTKEY}\Capabilities"

  ; "Open with Lathe": a file, a folder, and the inside of a folder.
  !insertmacro LATHE_ADD_VERB "*" "%1"
  !insertmacro LATHE_ADD_VERB "Directory" "%V"
  !insertmacro LATHE_ADD_VERB "Directory\Background" "%V"

  !insertmacro LATHE_PATH ""

  ; Tell Explorer that what apps can open has changed (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro LATHE_PATH "-Remove"
  DeleteRegKey SHCTX "Software\Classes\*\shell\Lathe"
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\Lathe"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\Lathe"
  !insertmacro LATHE_FILE_TYPES LATHE_REMOVE_TYPE
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
  DeleteRegKey SHCTX "${MANUPRODUCTKEY}\Capabilities"
  DeleteRegKey SHCTX "Software\Classes\${LATHE_PROGID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
