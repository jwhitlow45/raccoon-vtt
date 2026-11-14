# RaccoonVTT's folder in ProgramData, made by the installer, which runs
# elevated (installer.nsh). The app makes each user's own folder in it when
# PostgreSQL can't open that user's data folder by its path
# (desktop/runtime/pgPaths.ts, D-261113-219). Administrators own it, and its
# ACL lets a user only list it and make folders in it, with each folder its
# maker's alone from the moment it exists. desktop.yml runs this too, before
# the tests that need the folder.
#
# Run by Windows PowerShell 5.1, whose .NET Framework makes a folder with
# its security descriptor in one call. Exit 0 when the folder is right.

$ErrorActionPreference = 'Stop'
$path = Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'RaccoonVTT'

$system = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
$admins = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'
$users = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-545'
$creatorOwner = New-Object System.Security.Principal.SecurityIdentifier 'S-1-3-0'
$all = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'

$security = New-Object System.Security.AccessControl.DirectorySecurity
$security.SetOwner($admins)
$security.SetAccessRuleProtection($true, $false)
$security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, 'FullControl', $all, 'None', 'Allow')))
$security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, 'FullControl', $all, 'None', 'Allow')))
# This folder only: list it, read its ACL, make folders in it. No file, no delete, no change.
$security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($users, 'ListDirectory, CreateDirectories, Traverse, ReadAttributes, ReadPermissions', 'None', 'None', 'Allow')))
# What is made in it, its maker's.
$security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($creatorOwner, 'FullControl', $all, 'InheritOnly', 'Allow')))

# A plain folder that Administrators or SYSTEM own, with exactly the ACL
# above: protected, and those four entries, none inherited. Anything else may
# have been open to another user, who could still hold it, so it is never
# mended in place.
function Test-Trusted([string]$folder) {
  $item = Get-Item -LiteralPath $folder -Force
  if (-not $item.PSIsContainer) { return $false }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
  $acl = Get-Acl -LiteralPath $folder
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  if (-not (($owner -eq $admins) -or ($owner -eq $system))) { return $false }
  if (-not $acl.AreAccessRulesProtected) { return $false }
  $have = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $want = @($security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ($have.Count -ne $want.Count) { return $false }
  foreach ($w in $want) {
    $same = @($have | Where-Object { (-not $_.IsInherited) -and ($_.IdentityReference -eq $w.IdentityReference) -and ($_.FileSystemRights -eq $w.FileSystemRights) -and ($_.InheritanceFlags -eq $w.InheritanceFlags) -and ($_.PropagationFlags -eq $w.PropagationFlags) -and ($_.AccessControlType -eq $w.AccessControlType) })
    if ($same.Count -ne 1) { return $false }
  }
  return $true
}

for ($try = 0; $try -lt 3; $try++) {
  # Get-Item sees a link that leads nowhere, where Test-Path would not.
  if (Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue) {
    # An earlier install's, kept as it is with every user's folder in it.
    if (Test-Trusted $path) { exit 0 }
    # Anything else is moved aside, never used, mended or deleted.
    Rename-Item -LiteralPath $path -NewName ('RaccoonVTT.untrusted-' + [DateTime]::UtcNow.Ticks)
    continue
  }
  # Made with its security descriptor, so no one can open it in between.
  [void][System.IO.Directory]::CreateDirectory($path, $security)
  if (Test-Trusted $path) { exit 0 }
}
exit 1
