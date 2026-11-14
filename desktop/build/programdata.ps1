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

# A plain folder that Administrators or SYSTEM own: no one else could have changed it.
function Test-Trusted([string]$folder) {
  $item = Get-Item -LiteralPath $folder -Force
  if (-not $item.PSIsContainer) { return $false }
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $false }
  $owner = (Get-Acl -LiteralPath $folder).GetOwner([System.Security.Principal.SecurityIdentifier])
  return ($owner -eq $admins) -or ($owner -eq $system)
}

for ($try = 0; $try -lt 3; $try++) {
  # Get-Item sees a link that leads nowhere, where Test-Path would not.
  if (Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue) {
    if (Test-Trusted $path) {
      # An earlier install's: its ACL is set again, which also mends one an administrator changed.
      Set-Acl -LiteralPath $path -AclObject $security
      if (Test-Trusted $path) { exit 0 }
    }
    # Made by someone else, who may still hold it open: moved aside, never used or deleted.
    Rename-Item -LiteralPath $path -NewName ('RaccoonVTT.untrusted-' + [DateTime]::UtcNow.Ticks)
    continue
  }
  # Made with its security descriptor, so no one can open it in between.
  [void][System.IO.Directory]::CreateDirectory($path, $security)
  if (Test-Trusted $path) { exit 0 }
}
exit 1
