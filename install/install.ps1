# Install the Quanta command on Windows (PowerShell 5.1 or newer).
#   irm https://github.com/real-kijmoshi/quanta/releases/latest/download/install.ps1 | iex
# Options (environment variables): QUANTA_VERSION, QUANTA_HOME, QUANTA_REPO.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repo = if ($env:QUANTA_REPO) { $env:QUANTA_REPO } else { 'real-kijmoshi/quanta' }
$home_ = if ($env:QUANTA_HOME) { $env:QUANTA_HOME } else { Join-Path $env:USERPROFILE '.quanta' }
$version = if ($env:QUANTA_VERSION) { $env:QUANTA_VERSION } else { 'latest' }

function Fail($message) { Write-Host "error: $message" -ForegroundColor Red; throw $message }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 22 or newer is required. Install it from https://nodejs.org and run this again.' }
$major = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js 22 or newer is required (found $(& node -v))." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found; it ships with Node.js.' }

$base = if ($env:QUANTA_BASE_URL) { $env:QUANTA_BASE_URL } # testing: a URL holding quanta.tgz and SHA256SUMS
        elseif ($version -eq 'latest') { "https://github.com/$repo/releases/latest/download" }
        else { "https://github.com/$repo/releases/download/v$($version.TrimStart('v'))" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("quanta-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading Quanta ($version)..."
  Invoke-WebRequest "$base/quanta.tgz" -OutFile (Join-Path $tmp 'quanta.tgz')
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS')

  $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match ' quanta\.tgz$' } | Select-Object -First 1
  $expected = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
  $actual = (Get-FileHash (Join-Path $tmp 'quanta.tgz') -Algorithm SHA256).Hash.ToLower()
  if (-not $expected -or $expected -ne $actual) { Fail 'checksum mismatch; refusing to install.' }

  $app = Join-Path $home_ 'app'
  $next = Join-Path $home_ 'app.new'
  if (Test-Path $next) { Remove-Item $next -Recurse -Force }
  New-Item -ItemType Directory -Path $next -Force | Out-Null
  & tar -xzf (Join-Path $tmp 'quanta.tgz') -C $next --strip-components=1
  if ($LASTEXITCODE -ne 0) { Fail 'could not unpack the download.' }

  Write-Host 'Installing dependencies (this can take a minute)...'
  Push-Location $next
  try { & npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed.' }

  if (Test-Path $app) { Remove-Item $app -Recurse -Force }
  Move-Item $next $app

  $bin = Join-Path $home_ 'bin'
  New-Item -ItemType Directory -Path $bin -Force | Out-Null
  $shim = "@echo off`r`nnode `"%~dp0..\app\bin\quanta.mjs`" %*`r`n"
  Set-Content -Path (Join-Path $bin 'quanta.cmd') -Value $shim -Encoding ASCII

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin), 'User')
    Write-Host "Added $bin to your PATH. Open a new terminal to use it."
  }

  Write-Host ''
  Write-Host "Installed Quanta $(& node (Join-Path $app 'bin\quanta.mjs') --version) to $app"
  Write-Host "Your boards live in $home_\data and are kept when you update."
  Write-Host 'Start it:  quanta   (add --tunnel to share over the internet)'
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
