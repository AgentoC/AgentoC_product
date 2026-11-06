[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$MsiPath,
    [Parameter(Mandatory=$true)][string]$ExpectedFolder
)
$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\packaging\windows\AgentoC.Setup.cs'
Add-Type -Path $source -ReferencedAssemblies System.Windows.Forms
$type=[AppDomain]::CurrentDomain.GetAssemblies() | ForEach-Object { $_.GetType('AgentoCSetup', $false) } | Where-Object { $_ } | Select-Object -First 1
if(-not $type){throw 'setup type unavailable'}
$flags=[Reflection.BindingFlags]'NonPublic,Static'
$discover=$type.GetMethod('TryFindInstalledFolder',$flags)
$quiet=$type.GetMethod('IsQuiet',$flags)
$specified=$type.GetMethod('HasInstallFolder',$flags)
$arguments=[object[]]@([IO.Path]::GetFullPath($MsiPath),$null)
if(-not $discover.Invoke($null,$arguments) -or
   [IO.Path]::GetFullPath([string]$arguments[1]).TrimEnd('\') -ine [IO.Path]::GetFullPath($ExpectedFolder).TrimEnd('\')) {
    throw 'installed product folder was not discovered'
}
$missing=[object[]]@([IO.Path]::Combine([IO.Path]::GetTempPath(), 'missing-agentoc-setup-test.msi'),$null)
if($discover.Invoke($null,$missing)){throw 'missing MSI was unexpectedly accepted'}
foreach($arg in @('/q','/qn','/qn+','/quiet','/passive','/qb!')) {
    if(-not $quiet.Invoke($null,[object[]]@(,[string[]]@($arg)))){throw "quiet option was missed: $arg"}
}
if($quiet.Invoke($null,[object[]]@(,[string[]]@('/norestart')))){throw 'interactive arguments treated as quiet'}
if(-not $specified.Invoke($null,[object[]]@(,[string[]]@('AGENTOC_INSTALLFOLDER=D:\Apps\Ragent')))){throw 'explicit folder was missed'}
if($specified.Invoke($null,[object[]]@(,[string[]]@('/qn')))){throw 'absent folder was detected'}
Write-Output 'Windows setup installed-folder discovery passed'
