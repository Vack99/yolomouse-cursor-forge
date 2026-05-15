. "$PSScriptRoot\_TestHelper.ps1"

Test-Case 'helper Assert-Equal accepts matching values' {
    Assert-Equal 1 1 'one equals one'
}

Test-Case 'helper Assert-BytesEqual accepts matching arrays' {
    Assert-BytesEqual ([byte[]](1,2,3)) ([byte[]](1,2,3))
}
