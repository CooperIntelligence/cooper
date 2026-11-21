[Setup]
AppId=Cooper.Desktop
AppName=Cooper Desktop
AppVersion={#CooperVersion}
AppPublisher=Cooper Intelligence
DefaultDirName={localappdata}\Programs\Cooper Desktop
OutputDir={#SetupOutputDir}
OutputBaseFilename=CooperDesktopSetup-{#CooperVersion}-windows-x64
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
DisableProgramGroupPage=yes
DisableWelcomePage=no
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
SetupMutex=Cooper.Desktop.Setup
CloseApplications=yes
RestartApplications=no
SetupIconFile=cooper.ico
UninstallDisplayIcon={app}\cooper.ico

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "cooper.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\Cooper Desktop"; Filename: "{app}\Cooper Desktop.exe"; WorkingDir: "{app}"; IconFilename: "{app}\cooper.ico"

[Run]
Filename: "{app}\Cooper Desktop.exe"; Description: "Launch Cooper Desktop"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent
