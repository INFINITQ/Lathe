# For Lathe's installer: adds Lathe's bin folder to your PATH, or with -Remove takes it out.
# It changes only your own (per-user) PATH, and writes it back as it was written (the same text
# and registry type), so entries such as %USERPROFILE%\... stay as they are. The installer tells
# running programs afterwards.
param(
  [Parameter(Mandatory = $true)] [string] $Dir,
  [switch] $Remove,
  # The variable to change: Path, or another name when testing this script.
  [string] $Name = 'Path'
)
$ErrorActionPreference = 'Stop'
# Only a full folder path, as the installer passes it: anything else (a stray quote from a
# mangled command line, a relative path) must never end up in PATH.
if ($Dir -match '["<>|;*?]' -or -not [System.IO.Path]::IsPathRooted($Dir) -or $Dir -notmatch '^[A-Za-z]:\\') {
  throw "Not a folder path: $Dir"
}
if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
  throw "Not a variable name: $Name"
}
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  # REG_SZ stays REG_SZ and REG_EXPAND_SZ stays REG_EXPAND_SZ; a new value gets REG_EXPAND_SZ,
  # Windows' usual type for PATH. A value that isn't text is left alone.
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains $Name) {
    $kind = $key.GetValueKind($Name)
    if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and
        $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) {
      throw "Not a text value: $Name ($kind)"
    }
  }
  $raw = [string]$key.GetValue($Name, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  # Empty entries are kept too, so taking the folder out again gives back the very same text.
  $parts = @($raw -split ';')
  $others = @($parts | Where-Object { $_.TrimEnd('\') -ine $Dir.TrimEnd('\') })
  if ($Remove) { $next = $others }
  elseif ($others.Count -ne $parts.Count) { $next = $parts }
  elseif ($raw -eq '') { $next = @($Dir) }
  elseif ($parts[-1] -eq '') { $next = @($parts[0..($parts.Count - 2)]) + $Dir + '' }
  else { $next = $parts + $Dir }
  $value = $next -join ';'
  if ($value -ne $raw) {
    $key.SetValue($Name, $value, $kind)
  }
} finally {
  $key.Close()
}
