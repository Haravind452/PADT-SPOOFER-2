# install-driver.ps1
#
# Installs the project-bundled WinUSB driver for the bladeRF
# (bladerf-winusb.inf) into the Windows driver store and binds it to any
# connected bladeRF.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install-driver.ps1
#
# The script re-launches itself elevated if needed (pnputil requires admin).

$ErrorActionPreference = 'Stop'

$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($id)
$isAdmin = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host 'Requesting administrator privileges...'
    Start-Process powershell -Verb RunAs -ArgumentList @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"' + $PSCommandPath + '"')
    )
    exit
}

$inf = Join-Path $PSScriptRoot 'bladerf-winusb.inf'
if (-not (Test-Path -LiteralPath $inf)) {
    Write-Error "INF not found: $inf"
    exit 1
}

Write-Host "Adding driver package to the driver store: $inf"
& pnputil /add-driver $inf /install
if ($LASTEXITCODE -ne 0) {
    Write-Error "pnputil failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host ''
Write-Host 'Done. Verifying bladeRF devices:'
$devices = Get-PnpDevice | Where-Object { $_.InstanceId -match 'VID_2CF0|VID_04B4' }
if ($devices) {
    $devices | Select-Object Status, Class, FriendlyName, InstanceId | Format-List
} else {
    Write-Host 'No bladeRF is currently connected/enumerated.'
    Write-Host 'Plug it in now - the driver is in the store and will bind automatically.'
}
