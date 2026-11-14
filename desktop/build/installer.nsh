; RaccoonVTT's additions to electron-builder's NSIS installer and
; uninstaller (design 6 and 8.4), included by nsis.include in
; electron-builder.yml. The install is per-machine, so both run elevated and
; can manage the Windows Firewall rule.

; The programs RaccoonVTT runs from its install folder. Only these are
; waited for and ended, matched by name and by path: the uninstaller an
; update runs from the install folder, and electron-updater's elevate.exe
; beside it, must never hold the installer up.
!define RACCOON_PROGRAMS "'RaccoonVTT.exe','raccoonvtt-server.exe','postgres.exe','pg_ctl.exe','initdb.exe','pg_dump.exe','pg_restore.exe'"
; Run by its full path, never found on PATH, and fed the install folder
; through the environment, so no folder name can break the command's quoting.
!define RACCOON_PS `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`
!define RACCOON_FIND `$$d = $$env:RACCOONVTT_INSTDIR; $$n = @(${RACCOON_PROGRAMS}); Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$n -contains $$_.Name) -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) }`

; Sets RESULT to 0 while any of RaccoonVTT's programs runs from the install
; folder, 1 when none does, or "error" when PowerShell could not tell.
!macro raccoonRunning RESULT
  nsExec::Exec /TIMEOUT=30000 `${RACCOON_PS} "if (${RACCOON_FIND}) { exit 0 } else { exit 1 }"`
  Pop ${RESULT}
!macroend

; Waits up to SECONDS for RaccoonVTT's programs to end. RESULT as above.
!macro raccoonWait SECONDS RESULT
  StrCpy $R7 0
  ${Do}
    !insertmacro raccoonRunning ${RESULT}
    ${If} ${RESULT} != 0
    ${OrIf} $R7 >= ${SECONDS}
      ${Break}
    ${EndIf}
    IntOp $R7 $R7 + 1
    Sleep 1000
  ${Loop}
!macroend

; Replaces electron-builder's own check, in both the installer and the
; uninstaller (D-261113-099). First the running copy is asked to quit
; through its single-instance lock: it stops the app server and shuts
; PostgreSQL down cleanly, which ending it outright would not. A --quit
; that finds nothing running exits at once. Then the wait, up to 60 s, and
; only then are leftovers ended, after which PostgreSQL recovers from its
; log at the next start.
!macro customCheckAppRunning
  Push $R7
  Push $R8
  System::Call 'Kernel32::SetEnvironmentVariable(t "RACCOONVTT_INSTDIR", t "$INSTDIR\")i'
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Asking RaccoonVTT to quit."
    nsExec::Exec /TIMEOUT=30000 `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit`
    Pop $R8
  ${EndIf}
  !insertmacro raccoonWait 60 $R8
  ${If} $R8 == 0
    DetailPrint "Ending what is left of RaccoonVTT."
    nsExec::Exec /TIMEOUT=30000 `${RACCOON_PS} "${RACCOON_FIND} | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
    Pop $R8
    !insertmacro raccoonWait 10 $R8
  ${EndIf}
  Pop $R8
  Pop $R7
!macroend

; One rule, for the bundled server only, on private networks only (design 6):
; Windows then never prompts, and blocks it on public and domain networks.
; Deleting first means a reinstall or an update leaves exactly one.
!macro customInstall
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="RaccoonVTT"`
  Pop $0
  nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall add rule name="RaccoonVTT" dir=in action=allow program="$INSTDIR\resources\node\raccoonvtt-server.exe" protocol=TCP profile=private enable=yes`
  Pop $0
  ${If} $0 != 0
    DetailPrint "Windows Firewall did not take RaccoonVTT's rule (netsh: $0)."
  ${EndIf}
!macroend

; An update runs the old version's uninstaller before the new files go in,
; and the new installer adds the rule again, so the rule stays through it.
; A real uninstall removes it.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="RaccoonVTT"`
    Pop $0
  ${EndIf}
!macroend
