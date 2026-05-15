. "$PSScriptRoot\_TestHelper.ps1"
$forge = Join-Path $PSScriptRoot '..\forge.ps1'

Test-Case 'forge help prints command table' {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $forge help 2>&1 | Out-String
    Assert-True ($out -match 'new')     'mentions new'
    Assert-True ($out -match 'build')   'mentions build'
    Assert-True ($out -match 'install') 'mentions install'
    Assert-True ($out -match 'reload')  'mentions reload'
}

Test-Case 'forge with no args prints help and exits 0' {
    $out = & powershell -NoProfile -ExecutionPolicy Bypass -File $forge 2>&1 | Out-String
    Assert-True ($out -match 'new') 'help shown'
    Assert-Equal 0 $LASTEXITCODE 'exit code'
}
