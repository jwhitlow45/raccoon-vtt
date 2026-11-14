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
; Statements that set $d and $n, then one pipeline listing the programs.
; They stay two pieces: an `if (...)` condition takes a pipeline only, and
; assignments inside one are a parse error, whose exit code once read as
; "nothing running". An empty folder name would match every program.
!define RACCOON_FIND_SET `$$ErrorActionPreference = 'Stop'; $$d = $$env:RACCOONVTT_INSTDIR; if (-not $$d) { exit 2 }; $$n = @(${RACCOON_PROGRAMS})`
!define RACCOON_FIND_LIST `Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and ($$n -contains $$_.Name) -and $$_.ExecutablePath.StartsWith($$d, [StringComparison]::OrdinalIgnoreCase) }`

; Sets RESULT to 0 while any of RaccoonVTT's programs runs from the install
; folder and 1 when none does. Anything else (2 when the processes could
; not be listed, "error" or "timeout" from nsExec) means it could not tell.
!macro raccoonRunning RESULT
  nsExec::Exec /TIMEOUT=30000 `${RACCOON_PS} "try { ${RACCOON_FIND_SET}; $$p = @(${RACCOON_FIND_LIST}) } catch { exit 2 }; if ($$p.Count -gt 0) { exit 0 }; exit 1"`
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
; log at the next start. Files are replaced only once the check says
; nothing runs: a program still running, or a check that cannot tell,
; stops with words and Retry. A silent install takes Cancel and quits.
!macro customCheckAppRunning
  Push $R7
  Push $R8
  System::Call 'Kernel32::SetEnvironmentVariable(t "RACCOONVTT_INSTDIR", t "$INSTDIR\")i'
  ${Do}
    ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "Asking RaccoonVTT to quit."
      nsExec::Exec /TIMEOUT=30000 `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit`
      Pop $R8
    ${EndIf}
    !insertmacro raccoonWait 60 $R8
    ${If} $R8 == 0
      DetailPrint "Ending what is left of RaccoonVTT."
      nsExec::Exec /TIMEOUT=30000 `${RACCOON_PS} "${RACCOON_FIND_SET}; ${RACCOON_FIND_LIST} | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
      Pop $R8
      !insertmacro raccoonWait 10 $R8
    ${EndIf}
    ${If} $R8 == 1
      ${Break}
    ${ElseIf} $R8 == 0
      DetailPrint "RaccoonVTT is still running."
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "RaccoonVTT is still running and did not stop. Quit it from the notification area, then choose Retry." /SD IDCANCEL IDRETRY +2
      Quit
    ${Else}
      DetailPrint "Could not tell whether RaccoonVTT is running ($R8)."
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Windows could not tell whether RaccoonVTT is still running ($R8). Quit RaccoonVTT from the notification area if it is open, then choose Retry." /SD IDCANCEL IDRETRY +2
      Quit
    ${EndIf}
  ${Loop}
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
  ; RaccoonVTT's folder in ProgramData, where the app makes a user's own
  ; folder for PostgreSQL's junction when it can't open that user's data
  ; folder by its path (programdata.ps1). A failure only matters to such a
  ; user, whose app then says to reinstall.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\raccoonvtt-programdata.ps1" "${BUILD_RESOURCES_DIR}\programdata.ps1"
  nsExec::Exec /TIMEOUT=60000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\raccoonvtt-programdata.ps1"`
  Pop $0
  ${If} $0 != 0
    DetailPrint "RaccoonVTT could not make its folder in ProgramData (PowerShell: $0)."
  ${EndIf}
!macroend

; An update runs the old version's uninstaller before the new files go in,
; and the new installer adds the rule again, so the rule stays through it.
; A real uninstall removes it. RaccoonVTT's folder in ProgramData stays, as
; data folders do: a junction in it is how PostgreSQL reaches a user's
; database.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    nsExec::Exec `"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="RaccoonVTT"`
    Pop $0
  ${EndIf}
!macroend
