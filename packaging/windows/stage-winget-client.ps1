[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$PackagePath,
    [Parameter(Mandatory = $true)] [string]$PayloadRoot
)

$ErrorActionPreference = 'Stop'
# Microsoft.WinGet.Client 1.29.380, downloaded from PowerShell Gallery. The
# frozen digest makes builds reproducible and covers unsigned documentation as
# well as signed binaries. Update deliberately together with the package.
$expectedHash = '3469e5747eb6b100e51fed3f2057386b5ba60bc8955a6669b5c2eb562e316619'
$package = Get-Item -LiteralPath $PackagePath -Force
if ($package.PSIsContainer -or ($package.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'WGC_PACKAGE_INVALID' }
if ((Get-FileHash -LiteralPath $package.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) { throw 'WGC_PACKAGE_HASH_MISMATCH' }
$root = Get-Item -LiteralPath $PayloadRoot -Force
if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'WGC_PAYLOAD_ROOT_INVALID' }
$target = Join-Path $root.FullName 'vendor\Microsoft.WinGet.Client'
if (Test-Path -LiteralPath $target) { throw 'WGC_TARGET_ALREADY_EXISTS' }

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($package.FullName)
try {
    $allowedRoot = @('Microsoft.WinGet.Client.psd1', 'Format.ps1xml', 'Microsoft.WinGet.Client.Cmdlets.dll-Help.xml', 'NOTICE.txt')
    $entries = @($archive.Entries | Where-Object {
        $_.FullName -cin $allowedRoot -or $_.FullName.StartsWith('net8.0-windows10.0.26100.0/', [StringComparison]::Ordinal)
    } | Where-Object { $_.Name })
    if ($entries.Count -lt 10 -or $entries.Count -gt 128 -or (($entries | Measure-Object Length -Sum).Sum -gt 100MB)) { throw 'WGC_ARCHIVE_CONTENT_INVALID' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $entries) {
        $name = $entry.FullName
        if ($name -notmatch '^[A-Za-z0-9._/-]+$' -or @($name.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or -not $seen.Add($name)) { throw 'WGC_ARCHIVE_PATH_INVALID' }
        if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'WGC_ARCHIVE_LINK_REFUSED' }
    }
    [void](New-Item -ItemType Directory -Path $target)
    foreach ($entry in $entries) {
        $destination = Join-Path $target ($entry.FullName.Replace('/', [IO.Path]::DirectorySeparatorChar))
        $parent = Split-Path -Parent $destination
        if (-not (Test-Path -LiteralPath $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $false)
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.Extension -in @('.dll', '.winmd', '.psd1', '.ps1xml') })) {
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
        if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw 'WGC_COMPONENT_SIGNATURE_INVALID' }
    }
    # The signed Microsoft manifest selects its RootModule dynamically, so it
    # is not accepted by Import-PowerShellDataFile's restricted grammar.
    $manifestText = Get-Content -LiteralPath (Join-Path $target 'Microsoft.WinGet.Client.psd1') -Raw
    if (@([regex]::Matches($manifestText, "(?m)^\s*ModuleVersion\s*=\s*'1\.29\.380'\s*$")).Count -ne 1) { throw 'WGC_COMPONENT_VERSION_INVALID' }
    [pscustomobject]@{ version = '1.29.380'; sha256 = $expectedHash; path = $target; files = $entries.Count }
} finally { $archive.Dispose() }
