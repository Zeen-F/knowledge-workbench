; Never terminate processes by executable name: Codex may also be using the
; bundled Electron executable for an MCP connection. A sharing check touches
; only this installation, and leaves editors and connections running on failure.
!macro customCheckAppRunning
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 kwb_not_running
  ; A mapped executable may allow reads after its loader handle closes, but
  ; Windows refuses write access until the process has exited. No bytes are written.
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .r0'
  ${If} $0 == -1
    MessageBox MB_OK|MB_ICONEXCLAMATION "Knowledge Workbench is still in use. Save and close its windows and Codex connections, then try again. No process has been stopped." /SD IDOK
    SetErrorLevel 2
    Quit
  ${Else}
    System::Call 'kernel32::CloseHandle(p r0)'
  ${EndIf}
  kwb_not_running:
!macroend
