$ErrorActionPreference = 'Stop'
$tests = Get-ChildItem $PSScriptRoot -Filter '*.Tests.ps1' | Sort-Object Name
$totalPass = 0; $totalFail = 0
foreach ($t in $tests) {
    Write-Host "=== $($t.Name) ===" -ForegroundColor Cyan
    $localPass = 0; $localFail = 0
    # Each file uses Test-Case which returns $true/$false. We capture that.
    $results = & $t.FullName
    foreach ($r in $results) {
        if ($r -eq $true) { $localPass++ }
        elseif ($r -eq $false) { $localFail++ }
    }
    Write-Host "    $localPass passed, $localFail failed"
    $totalPass += $localPass; $totalFail += $localFail
}
Write-Host ''
Write-Host "Total: $totalPass passed, $totalFail failed" -ForegroundColor $(if ($totalFail -gt 0) { 'Red' } else { 'Green' })
if ($totalFail -gt 0) { exit 1 } else { exit 0 }
