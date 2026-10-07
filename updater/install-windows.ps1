# Lets the AutoLurk dashboard's Update now reach the updater on this computer.
# Run once per Windows user. Moving the AutoLurk folder means running it again.

$ErrorActionPreference = "Stop"
$hostName = "com.autolurk.updater"
$extensionId = "lofaafmcmpeoaflmfjainbofphpooboa"

$launcher = Join-Path $PSScriptRoot "autolurk-updater.bat"
$store = Join-Path $env:LOCALAPPDATA "AutoLurk"
New-Item -ItemType Directory -Force -Path $store | Out-Null
$manifestPath = Join-Path $store "$hostName.json"

$manifest = [ordered]@{
  name = $hostName
  description = "Updates the AutoLurk Companion folder from GitHub"
  path = $launcher
  type = "stdio"
  allowed_origins = @("chrome-extension://$extensionId/")
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

$browsers = @(
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
)
foreach ($base in $browsers) {
  $key = Join-Path $base $hostName
  New-Item -Force -Path $key | Out-Null
  Set-ItemProperty -Path $key -Name "(default)" -Value $manifestPath
}

Write-Host "AutoLurk updater is set up for $(Split-Path -Parent $PSScriptRoot)."
Write-Host "Open the AutoLurk dashboard and click Update now."
