# AutoLurk updater. The browser starts this when the dashboard's Update now is
# clicked. It reads one message, updates the folder above this one, and replies.
# Anything printed to stdout breaks the browser's message framing.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$folder = Split-Path -Parent $PSScriptRoot

function Read-Message {
  $stdin = [Console]::OpenStandardInput()
  $header = New-Object byte[] 4
  $read = 0
  while ($read -lt 4) {
    $n = $stdin.Read($header, $read, 4 - $read)
    if ($n -le 0) { return $null }
    $read += $n
  }
  $length = [BitConverter]::ToInt32($header, 0)
  $body = New-Object byte[] $length
  $read = 0
  while ($read -lt $length) {
    $n = $stdin.Read($body, $read, $length - $read)
    if ($n -le 0) { return $null }
    $read += $n
  }
  return [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
}

function Send-Reply($reply) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($reply | ConvertTo-Json -Compress))
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Read-Manifest($dir) {
  return Get-Content -Raw -Encoding UTF8 (Join-Path $dir "manifest.json") | ConvertFrom-Json
}

function Update-WithGit {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & git -C $folder pull --ff-only 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = $previous
  if ($code -ne 0) { throw "git pull failed: $($output.Trim())" }
  return "git"
}

function Update-WithZip($message) {
  $name = '^[A-Za-z0-9_.-]+$'
  if ($message.owner -notmatch $name -or $message.repo -notmatch $name) { throw "That is not a GitHub repository." }
  $branch = [string]$message.branch
  if ($branch -notmatch '^[A-Za-z0-9_./-]+$' -or $branch.Contains("..")) { throw "That is not a branch name." }

  $work = Join-Path ([IO.Path]::GetTempPath()) ("autolurk-update-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $zip = Join-Path $work "update.zip"
    $url = "https://codeload.github.com/$($message.owner)/$($message.repo)/zip/refs/heads/$branch"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    $unpacked = Join-Path $work "files"
    Expand-Archive -Path $zip -DestinationPath $unpacked
    $root = Get-ChildItem -Path $unpacked -Directory | Select-Object -First 1
    if (-not $root -or -not (Test-Path (Join-Path $root.FullName "manifest.json"))) {
      throw "The download has no manifest.json."
    }
    $current = Read-Manifest $folder
    $next = Read-Manifest $root.FullName
    if ($next.name -ne $current.name) { throw "That download is not AutoLurk." }
    if ($next.key -ne $current.key) { throw "That download would change the extension id. It was not applied." }
    Copy-Item -Path (Join-Path $root.FullName "*") -Destination $folder -Recurse -Force
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }
  return "zip"
}

try {
  $message = Read-Message
  if (-not $message) { exit 0 }
  if ($message.action -eq "status") {
    Send-Reply @{ ok = $true; version = (Read-Manifest $folder).version; folder = $folder }
    exit 0
  }
  if ($message.action -ne "update") { throw "Unknown request." }

  $hasGit = (Test-Path (Join-Path $folder ".git")) -and (Get-Command git -ErrorAction SilentlyContinue)
  if ($hasGit) { $method = Update-WithGit } else { $method = Update-WithZip $message }
  Send-Reply @{ ok = $true; method = $method; version = (Read-Manifest $folder).version }
} catch {
  Send-Reply @{ ok = $false; error = $_.Exception.Message }
}
