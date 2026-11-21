# Builds `peripheral-battery-cli.exe` into `rust/target/release/` and copies it
# into `bin/`, where the Host half expects it.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path $root 'rust')
try {
    cargo build --release
}
finally {
    Pop-Location
}

$target = Join-Path $root 'rust\target\release\peripheral-battery-cli.exe'
$destination = Join-Path $root 'bin\peripheral-battery-cli.exe'

New-Item -ItemType Directory -Force (Split-Path -Parent $destination) | Out-Null
Copy-Item $target $destination -Force

$daemonTarget = Join-Path $root 'rust\target\release\peripheral-battery-daemon.exe'
$daemonDestination = Join-Path $root 'bin\peripheral-battery-daemon.exe'
Copy-Item $daemonTarget $daemonDestination -Force

Write-Host "built $destination"
Write-Host "built $daemonDestination"
