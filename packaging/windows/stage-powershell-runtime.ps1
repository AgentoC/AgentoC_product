[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$ArchivePath,
    [Parameter(Mandatory = $true)] [string]$PayloadRoot,
    [ValidateSet('x64', 'arm64', 'x86')] [string]$Architecture = 'x64'
)

$ErrorActionPreference = 'Stop'
$hashes = @{
    x64 = '02fe458be20493fbdf43f61ea20610b811ee6c738ab1676c61b9cfcd1a33c860'
    arm64 = 'bbde9dda31d148415eccb5fbe1638e6400a144187b006e5b3fd8ec2f39d781be'
    x86 = '2b644d9cb695fe221af212e23f1c38d3310655b37760ef7741b0fa453b32011e'
}
$archiveFile = Get-Item -LiteralPath $ArchivePath -Force
if ($archiveFile.PSIsContainer -or ($archiveFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'PSR_ARCHIVE_INVALID' }
if ((Get-FileHash -LiteralPath $archiveFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $hashes[$Architecture]) { throw 'PSR_ARCHIVE_HASH_MISMATCH' }
$root = Get-Item -LiteralPath $PayloadRoot -Force
if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'PSR_PAYLOAD_ROOT_INVALID' }
$target = Join-Path $root.FullName 'vendor\PowerShell'
if (Test-Path -LiteralPath $target) { throw 'PSR_TARGET_ALREADY_EXISTS' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archiveFile.FullName)
try {
    $entries = @($archive.Entries | Where-Object { $_.Name })
    if ($entries.Count -lt 100 -or $entries.Count -gt 2000 -or (($entries | Measure-Object Length -Sum).Sum -gt 400MB)) { throw 'PSR_ARCHIVE_CONTENT_INVALID' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $entries) {
        $name = $entry.FullName
        if ($name -notmatch '^[A-Za-z0-9._/-]+$' -or @($name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or -not $seen.Add($name)) { throw 'PSR_ARCHIVE_PATH_INVALID' }
        if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'PSR_ARCHIVE_LINK_REFUSED' }
    }
    if (-not $seen.Contains('pwsh.exe') -or -not $seen.Contains('LICENSE.txt')) { throw 'PSR_REQUIRED_FILE_MISSING' }
    [void](New-Item -ItemType Directory -Path $target)
    foreach ($entry in $entries) {
        $destination = Join-Path $target ($entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
    }
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $target 'pwsh.exe')
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '^CN=Microsoft Corporation(?:,|$)') { throw 'PSR_EXECUTABLE_SIGNATURE_INVALID' }
    [pscustomobject]@{ version = '7.6.6'; architecture = $Architecture; sha256 = $hashes[$Architecture]; path = $target; files = $entries.Count }
} finally { $archive.Dispose() }
