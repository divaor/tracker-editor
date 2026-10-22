; The uninstaller removes what the app registered in Explorer (electron/shellIntegration.cjs):
; Open with, Edit with Tracker Editor and Open in Tracker Editor, for the current user.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  DeleteRegKey HKCU "Software\Classes\TrackerEditor.File"
  DeleteRegKey HKCU "Software\Classes\*\shell\TrackerEditor"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\TrackerEditor"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\TrackerEditor"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
