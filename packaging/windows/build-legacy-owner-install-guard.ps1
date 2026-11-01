[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $OutputPath){throw 'OLG_OUTPUT_COLLISION'}
$guardCompiler='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $guardCompiler /nologo /target:exe /platform:x64 /reference:System.Management.dll /out:$OutputPath (Join-Path $PSScriptRoot 'legacy-owner-install-guard.cs')
if($LASTEXITCODE -ne 0){throw 'OLG_COMPILATION_FAILED'}
