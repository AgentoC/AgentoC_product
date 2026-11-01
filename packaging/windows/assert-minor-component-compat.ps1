[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$PreviousMsiPath,
    [Parameter(Mandatory=$true)][string]$CandidateMsiPath,
    [Parameter(Mandatory=$true)][string]$PreviousMsiSha256,
    [Parameter(Mandatory=$true)][string]$PreviousMsiProductVersion,
    [Parameter(Mandatory=$true)][string]$CandidateMsiProductVersion,
    [Parameter(Mandatory=$true)][string]$ReportPath
)
$ErrorActionPreference='Stop'
if($PreviousMsiSha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'MSI_MINOR_PREVIOUS_HASH_INVALID'}
$previous=[IO.Path]::GetFullPath($PreviousMsiPath)
$candidate=[IO.Path]::GetFullPath($CandidateMsiPath)
if($previous -ieq $candidate){throw 'MSI_MINOR_PREVIOUS_EQUALS_CANDIDATE'}
if((Get-FileHash -LiteralPath $previous -Algorithm SHA256).Hash -ine $PreviousMsiSha256){throw 'MSI_MINOR_PREVIOUS_HASH_MISMATCH'}
$installer=New-Object -ComObject WindowsInstaller.Installer
function Read-MsiRows([string]$Path,[string]$Query,[int]$FieldCount){
    $db=$installer.OpenDatabase($Path,0)
    $view=$db.OpenView($Query)
    $null=$view.Execute()
    $rows=[Collections.Generic.List[object]]::new()
    while($record=$view.Fetch()){
        $values=New-Object object[] $FieldCount
        for($index=0;$index -lt $FieldCount;$index++){$values[$index]=[string]$record.StringData($index+1)}
        $rows.Add([pscustomobject]@{values=$values})
    }
    $null=$view.Close()
    return $rows.ToArray()
}
function Read-MsiVersion([string]$Path){
    $rows=@(Read-MsiRows $Path 'SELECT `Value` FROM `Property` WHERE `Property`=''ProductVersion''' 1)
    if($rows.Count -ne 1){throw 'MSI_MINOR_VERSION_PROPERTY_MISSING'}
    return [string]$rows[0].values[0]
}
if((Read-MsiVersion $previous) -cne $PreviousMsiProductVersion){throw 'MSI_MINOR_PREVIOUS_VERSION_MISMATCH'}
if((Read-MsiVersion $candidate) -cne $CandidateMsiProductVersion){throw 'MSI_MINOR_CANDIDATE_VERSION_MISMATCH'}
$old=Read-MsiRows $previous 'SELECT `Component`,`ComponentId` FROM `Component`' 2
$new=Read-MsiRows $candidate 'SELECT `Component`,`ComponentId` FROM `Component`' 2
$oldByName=@{};foreach($row in $old){if(-not $row.values[0]){throw 'MSI_MINOR_PREVIOUS_COMPONENT_INVALID'};$oldByName[$row.values[0]]=$row.values[1]}
$newByName=@{};foreach($row in $new){if(-not $row.values[0]){throw 'MSI_MINOR_CANDIDATE_COMPONENT_INVALID'};$newByName[$row.values[0]]=$row.values[1]}
$removed=@($oldByName.Keys|Where-Object {-not $newByName.ContainsKey($_)})
$changed=@($oldByName.Keys|Where-Object {$newByName.ContainsKey($_) -and $newByName[$_] -cne $oldByName[$_]})
$oldEdges=Read-MsiRows $previous 'SELECT `Feature_`,`Component_` FROM `FeatureComponents`' 2
$newEdges=Read-MsiRows $candidate 'SELECT `Feature_`,`Component_` FROM `FeatureComponents`' 2
$newEdgeSet=@{};foreach($edge in $newEdges){$newEdgeSet[$edge.values[0]+'|'+$edge.values[1]]=1}
$removedEdges=@($oldEdges|Where-Object {-not $newEdgeSet.ContainsKey($_.values[0]+'|'+$_.values[1])}|ForEach-Object {$_.values[0]+'|'+$_.values[1]})
$report=[ordered]@{
    pass=($removed.Count -eq 0 -and $changed.Count -eq 0 -and $removedEdges.Count -eq 0)
    previousMsiSha256=$PreviousMsiSha256.ToLowerInvariant()
    candidateMsiSha256=(Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    previousMsiProductVersion=$PreviousMsiProductVersion;candidateMsiProductVersion=$CandidateMsiProductVersion
    previousComponentCount=$old.Count;candidateComponentCount=$new.Count
    removedComponentCount=$removed.Count;changedGuidCount=$changed.Count;removedFeatureEdgeCount=$removedEdges.Count
    removedExamples=@($removed|Select-Object -First 10);changedExamples=@($changed|Select-Object -First 10);removedEdgeExamples=@($removedEdges|Select-Object -First 10)
}
$report|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $ReportPath -Encoding UTF8
$report|ConvertTo-Json -Depth 5
if(-not $report.pass){throw 'MSI_MINOR_COMPONENT_TREE_INCOMPATIBLE'}
