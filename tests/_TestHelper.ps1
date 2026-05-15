# Minimal assertion + tempdir helpers. Dot-sourced by each *.Tests.ps1 file.
# Throws on failure so the outer runner can catch and tally.

$script:CurrentTest = ''

function Test-Case {
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
    $script:CurrentTest = $Name
    try {
        & $Body
        Write-Host "  PASS  $Name" -ForegroundColor Green
        return $true
    } catch {
        Write-Host "  FAIL  $Name" -ForegroundColor Red
        Write-Host "        $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message = 'values differ')
    if ($Expected -ne $Actual) {
        throw "$Message`n        Expected: <$Expected>`n        Actual:   <$Actual>"
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message = 'expected true')
    if (-not $Condition) { throw $Message }
}

function Assert-BytesEqual {
    param([byte[]]$Expected, [byte[]]$Actual, [string]$Message = 'byte arrays differ')
    if ($null -eq $Actual) { throw "$Message`n        Actual is `$null" }
    if ($Expected.Length -ne $Actual.Length) {
        throw "$Message`n        Length: expected $($Expected.Length), got $($Actual.Length)"
    }
    for ($i = 0; $i -lt $Expected.Length; $i++) {
        if ($Expected[$i] -ne $Actual[$i]) {
            $e = '0x{0:X2}' -f $Expected[$i]
            $a = '0x{0:X2}' -f $Actual[$i]
            throw "$Message`n        Byte $i differs: expected $e, got $a"
        }
    }
}

function Assert-BytesEqualAt {
    param([byte[]]$Expected, [byte[]]$Actual, [int]$Offset, [string]$Message = 'bytes differ at offset')
    for ($i = 0; $i -lt $Expected.Length; $i++) {
        $a = $Actual[$Offset + $i]
        if ($Expected[$i] -ne $a) {
            $e = '0x{0:X2}' -f $Expected[$i]
            $g = '0x{0:X2}' -f $a
            throw "$Message`n        At offset $($Offset + $i): expected $e, got $g"
        }
    }
}

function Assert-Throws {
    param([scriptblock]$Body, [string]$MatchPattern = '.*')
    try { & $Body } catch {
        if ($_.Exception.Message -notmatch $MatchPattern) {
            throw "Threw, but message did not match /$MatchPattern/`n        Message was: $($_.Exception.Message)"
        }
        return
    }
    throw 'Expected an exception, none was thrown'
}

function New-TempDir {
    $d = Join-Path $env:TEMP ("forge-test-" + [Guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    return $d
}
