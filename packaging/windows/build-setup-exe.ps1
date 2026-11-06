[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$MsiPath,
    [Parameter(Mandatory=$true)][string]$IconPath,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$msi = [IO.Path]::GetFullPath($MsiPath)
$icon = [IO.Path]::GetFullPath($IconPath)
$output = [IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path -LiteralPath $msi -PathType Leaf) -or -not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw 'Installer MSI and icon are required.' }
$buildRecord = $msi + '.build.json'
if (Test-Path -LiteralPath $buildRecord -PathType Leaf) {
    $record = Get-Content -LiteralPath $buildRecord -Raw | ConvertFrom-Json
    $revision = [string]$record.sourceCommit
    if ($revision -cnotmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') { throw 'SETUP_SOURCE_IDENTITY_INVALID' }
    $repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    foreach ($item in @('packaging/windows/build-setup-exe.ps1','packaging/windows/AgentoC.Setup.cs','packaging/windows/write-setup-metadata.ps1')) {
        $expected = (& git.exe -C $repo rev-parse ("${revision}:$item")).Trim()
        if ($LASTEXITCODE -ne 0) { throw "SETUP_SOURCE_MISSING: $item" }
        $actual = (& git.exe -C $repo hash-object "--path=$item" (Join-Path $repo $item)).Trim()
        if ($LASTEXITCODE -ne 0 -or $actual -cne $expected) { throw "SETUP_SOURCE_MISMATCH: $item" }
    }
}
$hashFile = Join-Path ([IO.Path]::GetTempPath()) ('agentoc-setup-hash-' + [guid]::NewGuid().ToString('N') + '.txt')
try {
    [IO.File]::WriteAllText($hashFile, (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash, [Text.Encoding]::ASCII)
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $source = Join-Path $PSScriptRoot 'AgentoC.Setup.cs'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll ('/win32icon:' + $icon) ('/resource:' + $msi + ',AgentoC.Payload.msi') ('/resource:' + $hashFile + ',AgentoC.Payload.sha256') ('/out:' + $output) $source
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'Installer launcher build failed.' }
    if (Test-Path -LiteralPath $buildRecord -PathType Leaf) {
        & (Join-Path $PSScriptRoot 'write-setup-metadata.ps1') -MsiPath $msi -SetupPath $output
    }
    Write-Output ("Built Windows setup executable: " + $output)
} finally {
    if (Test-Path -LiteralPath $hashFile -PathType Leaf) { Remove-Item -LiteralPath $hashFile -Force }
}
