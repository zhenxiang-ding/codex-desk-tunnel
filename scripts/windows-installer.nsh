; The cxdt the client carries (resources\cxdt) goes on the current user's PATH when the client is installed, and off
; it when the client is removed; an update keeps it there. apps/cli/install/desktop-path.ps1 edits the PATH.

!macro cxdtPath Folder Switch
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cxdt\desktop-path.ps1" -Directory "$INSTDIR\resources\${Folder}" ${Switch}'
  Pop $0
!macroend

!macro customInstall
  ; Earlier Codex installers added this folder under this same installation.
  !insertmacro cxdtPath "ccdt" "-Remove"
  !insertmacro cxdtPath "cxdt" ""
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro cxdtPath "cxdt" "-Remove"
  ${endIf}
!macroend
