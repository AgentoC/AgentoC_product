[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$NodePath,
    [Parameter(Mandatory = $true)] [string]$PayloadRoot
)

$ErrorActionPreference = 'Stop'
$nodeRuntimeRoot = Split-Path -Parent $NodePath
$payloadNodeModules = Join-Path $PayloadRoot 'node_modules'
New-Item -ItemType Directory -Path $payloadNodeModules -Force | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $PayloadRoot 'node.exe') -Force
foreach ($commandShim in @('npm.cmd', 'corepack.cmd')) {
    $sourceShim = Join-Path $nodeRuntimeRoot $commandShim
    if (-not (Test-Path -LiteralPath $sourceShim -PathType Leaf)) { throw "Missing Node runtime command shim: $commandShim" }
    Copy-Item -LiteralPath $sourceShim -Destination (Join-Path $PayloadRoot $commandShim) -Force
}
foreach ($runtimeModule in @('npm', 'corepack')) {
    $sourceModule = Join-Path $nodeRuntimeRoot (Join-Path 'node_modules' $runtimeModule)
    $targetModule = Join-Path $payloadNodeModules $runtimeModule
    New-Item -ItemType Directory -Path $targetModule -Force | Out-Null
    # npm's manuals include sample PEM private keys. They are not needed by
    # Harness installation; keep executable code/dependencies, not help manuals.
    # The final secret scanner remains strict over everything actually shipped.
    Get-ChildItem -LiteralPath $sourceModule -Force | Where-Object {
        $runtimeModule -ne 'npm' -or $_.Name -notin @('docs', 'man')
    } | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $targetModule -Recurse -Force
    }
}
# npm ci removes unlisted modules. Call this only AFTER dependency installation,
# then execute the staged runtime rather than checking only the source Node tree.
$payloadNode = Join-Path $PayloadRoot 'node.exe'
foreach ($entrypoint in @('node_modules\npm\bin\npm-cli.js', 'node_modules\corepack\dist\corepack.js')) {
    $stagedEntrypoint = Join-Path $PayloadRoot $entrypoint
    if (-not (Test-Path -LiteralPath $stagedEntrypoint -PathType Leaf)) { throw "Missing staged Node runtime entrypoint: $entrypoint" }
    & $payloadNode $stagedEntrypoint --version
    if ($LASTEXITCODE -ne 0) { throw "Staged Node runtime failed: $entrypoint" }
}
