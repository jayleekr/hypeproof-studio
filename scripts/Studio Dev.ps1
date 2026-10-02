[CmdletBinding()]
param(
  [ValidateSet('claude', 'codex', 'service')][string]$Provider = 'codex',
  [switch]$SetupLocal
)
$ErrorActionPreference = 'Stop'
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $taskDevArgs = @('scripts/studio-dev.py', '--provider', $Provider)
  if ($SetupLocal) { $taskDevArgs += '--setup-local' }
  $taskDevArgs += 'run'
  & python @taskDevArgs
  if ($LASTEXITCODE -ne 0) { throw 'Studio Dev did not start; review the launcher diagnostic above.' }
} finally { Pop-Location }
