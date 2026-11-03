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
$hashFile = Join-Path ([IO.Path]::GetTempPath()) ('agentoc-setup-hash-' + [guid]::NewGuid().ToString('N') + '.txt')
try {
    [IO.File]::WriteAllText($hashFile, (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash, [Text.Encoding]::ASCII)
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $source = Join-Path $PSScriptRoot 'AgentoC.Setup.cs'
    & $compiler /nologo /target:winexe /platform:x64 /optimize+ /reference:System.Windows.Forms.dll ('/win32icon:' + $icon) ('/resource:' + $msi + ',AgentoC.Payload.msi') ('/resource:' + $hashFile + ',AgentoC.Payload.sha256') ('/out:' + $output) $source
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'Installer launcher build failed.' }
    Write-Output ("Built Windows setup executable: " + $output)
} finally {
    if (Test-Path -LiteralPath $hashFile -PathType Leaf) { Remove-Item -LiteralPath $hashFile -Force }
}
