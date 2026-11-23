function OverlappingInstallRoots(Left, Right: String): Boolean;
begin
  Left := AddBackslash(ExpandFileName(Left));
  Right := AddBackslash(ExpandFileName(Right));
  Result := (CompareText(Copy(Left, 1, Length(Right)), Right) = 0) or
    (CompareText(Copy(Right, 1, Length(Left)), Left) = 0);
end;

function OtherChannelInstallError(Target: String): String;
var
  RegisteredRoot: String;
begin
  Result := '';
  if OverlappingInstallRoots(Target, ExpandConstant('{#OtherDefaultDir}')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#OtherAppId}_is1',
      'InstallLocation', RegisteredRoot) and (RegisteredRoot <> '') and
      OverlappingInstallRoots(Target, RegisteredRoot)) then
    Result := 'Choose a directory outside the other Cooper channel installation.';
end;
