$ErrorActionPreference='Stop'
$source=Join-Path $PSScriptRoot '..\packaging\windows\build-msi.ps1'
$tokens=$null;$parseErrors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw 'MSI_VERSION_BUILDER_PARSE_FAILED'}
$function=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-MsiVersion'},$true)
if(-not $function){throw 'MSI_VERSION_CONVERSION_MISSING'}
. ([scriptblock]::Create($function.Extent.Text))
$old=ConvertTo-MsiVersion '0.3.18'
$next=ConvertTo-MsiVersion '0.3.19'
if($next.CompareTo($old) -le 0){throw 'MSI_VERSION_NOT_INCREASING'}
foreach($value in @('0.3.18.49','0.3.65536','256.3.19','0.256.19')){
    try{$null=ConvertTo-MsiVersion $value;throw ('MSI_VERSION_ACCEPTED_INVALID_'+$value)}
    catch{if($_.Exception.Message -like 'MSI_VERSION_ACCEPTED_INVALID_*'){throw}}
}
'MSI_EFFECTIVE_VERSION_PASS old=0.3.18 next=0.3.19 rejected=4'
