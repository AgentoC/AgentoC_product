# Read-only verification of the actual Windows Installer condition and action
# tables. This does not install the supplied MSI or change any service.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$MsiPath)
$ErrorActionPreference='Stop'
$path=(Resolve-Path -LiteralPath $MsiPath).Path
$installer=New-Object -ComObject WindowsInstaller.Installer
$installer.UILevel=2
$database=$installer.OpenDatabase($path,0)
$session=$installer.OpenPackage($path,0)
$actions=@('ManagedSameUpgradeGuard','ManagedSameUpgradeRollback','ManagedSameUpgradeBegin','StopServices','ManagedMajorBrokerRollback','ManagedPrepareExisting','ManagedUpgradeCommit','ManagedRemove')
$conditions=@{};$sequences=@{}
foreach($action in $actions){
 $view=$database.OpenView("SELECT ``Sequence``,``Condition`` FROM ``InstallExecuteSequence`` WHERE ``Action``='$action'")
 $view.Execute();$record=$view.Fetch();if(-not $record){throw "ACTION_MISSING_$action"}
 $sequences[$action]=$record.IntegerData(1);$conditions[$action]=$record.StringData(2);$view.Close()
}
if(-not ($sequences.ManagedSameUpgradeGuard -lt $sequences.ManagedSameUpgradeRollback -and $sequences.ManagedSameUpgradeRollback -lt $sequences.ManagedSameUpgradeBegin -and $sequences.ManagedSameUpgradeBegin -lt $sequences.StopServices)){throw 'REINSTALL_SEQUENCE_INVALID'}
$scenarios=@(
 @{name='same-reinstall';installed='1';reinstall='ALL';remove='';related='';expected=@(1,1,1,0,1,1,0)},
 @{name='major-upgrade';installed='';reinstall='';remove='';related='{11111111-1111-1111-1111-111111111111}';expected=@(0,0,0,1,1,1,0)},
 @{name='fresh-install';installed='';reinstall='';remove='';related='';expected=@(0,0,0,0,0,0,0)},
 @{name='uninstall';installed='1';reinstall='';remove='ALL';related='';expected=@(0,0,0,0,0,0,1)}
)
$tested=@('ManagedSameUpgradeGuard','ManagedSameUpgradeRollback','ManagedSameUpgradeBegin','ManagedMajorBrokerRollback','ManagedPrepareExisting','ManagedUpgradeCommit','ManagedRemove')
foreach($scenario in $scenarios){
 $session.Property('Installed')=$scenario.installed;$session.Property('REINSTALL')=$scenario.reinstall
 $session.Property('REMOVE')=$scenario.remove;$session.Property('WIX_UPGRADE_DETECTED')=$scenario.related
 $actual=@($tested|ForEach-Object {[int]$session.EvaluateCondition($conditions[$_])})
 if(($actual -join ',') -cne ($scenario.expected -join ',')){throw ('CONDITION_MISMATCH_'+$scenario.name+':'+($actual -join ','))}
}
@{pass=$true;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash;scenarios=@($scenarios|ForEach-Object {$_.name});installationPerformed=$false}|ConvertTo-Json -Compress
