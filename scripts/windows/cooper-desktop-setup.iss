#if CooperInternal == "1"
  #define CooperAppId "Cooper.Desktop.Internal"
  #define CooperAppName "Cooper Desktop Internal"
  #define OtherAppId "Cooper.Desktop"
  #define OtherDefaultDir "{localappdata}\Programs\Cooper Desktop"
#else
  #define CooperAppId "Cooper.Desktop"
  #define CooperAppName "Cooper Desktop"
  #define OtherAppId "Cooper.Desktop.Internal"
  #define OtherDefaultDir "{localappdata}\Programs\Cooper Desktop Internal"
#endif

[Setup]
AppId={#CooperAppId}
AppName={#CooperAppName}
AppVersion={#CooperVersion}
AppPublisher=Cooper Intelligence
DefaultDirName={localappdata}\Programs\{#CooperAppName}
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
SetupMutex={#CooperAppId}.Setup
CloseApplications=yes
RestartApplications=no
SetupIconFile=cooper.ico
UninstallDisplayIcon={app}\cooper.ico

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "cooper.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\{#CooperAppName}"; Filename: "{app}\{#CooperAppName}.exe"; WorkingDir: "{app}"; IconFilename: "{app}\cooper.ico"; AppUserModelID: "{#CooperAppId}"

[Run]
Filename: "{app}\{#CooperAppName}.exe"; Description: "Launch {#CooperAppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
#include "setup-install-root.iss"

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := OtherChannelInstallError(ExpandConstant('{app}'));
end;
