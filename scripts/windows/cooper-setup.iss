[Setup]
AppId=Cooper.CLI.Native
AppName=Cooper CLI
AppVersion={#CooperVersion}
AppPublisher=Cooper Intelligence
DefaultDirName={localappdata}\Cooper
OutputDir={#SetupOutputDir}
OutputBaseFilename=CooperSetup-{#CooperVersion}-windows-x64
PrivilegesRequired=lowest
ArchitecturesAllowed=x64os
ArchitecturesInstallIn64BitMode=x64os
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableWelcomePage=no
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
ChangesEnvironment=yes
SetupMutex=Cooper.CLI.Native.Setup
CloseApplications=yes
RestartApplications=no
SetupIconFile=cooper.ico
UninstallDisplayIcon={app}\cooper.ico

[Files]
Source: "{#LauncherPath}"; DestDir: "{app}\bin"; DestName: "cooper.exe"; Flags: ignoreversion
Source: "{#PayloadPath}"; DestDir: "{app}\versions\{#CooperVersion}"; DestName: "cooper.exe"; Flags: ignoreversion
Source: "{#SandboxPath}"; DestDir: "{app}\versions\{#CooperVersion}"; DestName: "cooper-shell-sandbox.exe"; Flags: ignoreversion
Source: "cooper.ico"; DestDir: "{app}"; Flags: ignoreversion

[UninstallDelete]
Type: files; Name: "{app}\current.json"
Type: files; Name: "{app}\current.next.json"
Type: files; Name: "{app}\install.lock"
Type: filesandordirs; Name: "{app}\versions"
Type: dirifempty; Name: "{app}\bin"

[Code]
const
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Cooper.CLI.Native_is1';

var
  LaunchLock: TFileStream;
  ManagedBin: String;

function SetChildVariable(Name, Value: String): Integer;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

function EditUserPath(Action: String): Boolean;
var
  ExitCode: Integer;
begin
  Log('Cooper user PATH ' + Action + ' for ' + ManagedBin);
  Result := False;
  if (SetChildVariable('COOPER_SETUP_PATH_ACTION', Action) = 0) or
     (SetChildVariable('COOPER_SETUP_BIN', ManagedBin) = 0) then
    Exit;
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -NonInteractive -EncodedCommand {#PathScript}', '', SW_HIDE,
      ewWaitUntilTerminated, ExitCode) then
    Result := ExitCode = 0;
end;

function DirectoryIsEmpty(Directory: String): Boolean;
var
  Entry: TFindRec;
begin
  Result := True;
  if FindFirst(AddBackslash(Directory) + '*', Entry) then
  try
    repeat
      if (Entry.Name <> '.') and (Entry.Name <> '..') and (Entry.Name <> 'run.lock') then
      begin
        Result := False;
        Exit;
      end;
    until not FindNext(Entry);
  finally
    FindClose(Entry);
  end;
end;

function AcquireLaunchLock(): Boolean;
var
  LockPath: String;
begin
  try
    ForceDirectories(ExpandConstant('{app}'));
    LockPath := ExpandConstant('{app}\run.lock');
    if FileExists(LockPath) then
      LaunchLock := TFileStream.Create(LockPath, fmOpenReadWrite or fmShareExclusive)
    else
      LaunchLock := TFileStream.Create(LockPath, fmCreate);
    Result := True;
  except
    Log(GetExceptionMessage);
    Result := False;
  end;
end;

procedure ReleaseLaunchLock();
begin
  if LaunchLock <> nil then
  begin
    LaunchLock.Free;
    LaunchLock := nil;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  RegisteredRoot, Target: String;
begin
  Result := '';
  Target := ExpandConstant('{app}');
  ManagedBin := AddBackslash(Target) + 'bin';
  if RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', RegisteredRoot) then
  begin
    if CompareText(RemoveBackslashUnlessRoot(RegisteredRoot), RemoveBackslashUnlessRoot(Target)) <> 0 then
      Result := 'Cooper CLI is already installed at ' + RegisteredRoot + '.';
  end
  else if not DirectoryIsEmpty(Target) and not (FileExists(Target + '\current.json') and
    FileExists(Target + '\bin\cooper.exe') and DirExists(Target + '\versions')) then
    Result := 'The selected directory already contains files from another installation.';

  if Result = '' then
    if not AcquireLaunchLock() then
      Result := 'Close running Cooper CLI instances and try again.';
end;

procedure CurStepChanged(Step: TSetupStep);
var
  ExitCode: Integer;
begin
  if Step = ssPostInstall then
  begin
    if not Exec(ExpandConstant('{app}\bin\cooper.exe'), '--launcher-setup {#CooperVersion}', '',
        SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      RaiseException('Setup could not activate the installed Cooper version. Run Setup again to repair it.');
    if not EditUserPath('add') then
      RaiseException('Setup could not add Cooper to the user PATH. Run Setup again to repair it.');
  end;
end;

procedure DeinitializeSetup();
begin
  ReleaseLaunchLock();
end;

function InitializeUninstall(): Boolean;
var
  Target: String;
begin
  if not RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', Target) then
    Target := ExpandConstant('{app}');
  ManagedBin := AddBackslash(Target) + 'bin';
  Result := AcquireLaunchLock();
  if not Result then
    SuppressibleMsgBox('Close running Cooper CLI instances before uninstalling.', mbError, MB_OK, IDOK);
end;

procedure CurUninstallStepChanged(Step: TUninstallStep);
begin
  if Step = usUninstall then
    if not EditUserPath('remove') then
      RaiseException('Uninstall could not remove the Cooper entry from the user PATH.');
  if Step = usPostUninstall then
  begin
    ReleaseLaunchLock();
    DeleteFile(ExpandConstant('{app}\run.lock'));
    RemoveDir(ExpandConstant('{app}'));
  end;
end;

procedure DeinitializeUninstall();
begin
  ReleaseLaunchLock();
end;
