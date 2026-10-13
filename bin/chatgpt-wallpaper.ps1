param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)
$ErrorActionPreference = 'Stop'
$bridge = Join-Path $PSScriptRoot '..\src\bridge.mjs'
& node $bridge @Args
exit $LASTEXITCODE
