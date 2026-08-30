<#
  Upload Cashfra to Hostinger over FTPS, from Windows PowerShell.
  Uses curl.exe, which ships with Windows 10 and 11 — nothing to install.

  Run it from the folder holding index.html (the repo, or the extracted
  cashfra-deploy.zip):

      powershell -ExecutionPolicy Bypass -File deploy\upload-ftp.ps1 `
        -FtpHost <ftp host from hPanel> -User <ftp username>

  Only the files below are uploaded, so running it from the repo root will
  never push README.md, test/ or .git to your site.
#>
param(
  [Parameter(Mandatory = $true)][string]$FtpHost,
  [Parameter(Mandatory = $true)][string]$User,
  [string]$Domain = 'cashfra.com',
  [string]$Remote = 'public_html'
)

$ErrorActionPreference = 'Stop'
$Files = @('index.html', 'manifest.json', 'sw.js', 'favicon.ico', 'robots.txt', '.htaccess')
$Dirs  = @('icons')

foreach ($f in $Files) {
  if (-not (Test-Path -LiteralPath $f)) {
    throw "$f is not here. Run this from the folder that holds index.html."
  }
}

# The shell is served cache-first, so an unchanged cache name means installed
# copies keep the old build. Warn before wasting an upload.
$localBuild = (Select-String -Path sw.js -Pattern "^var BUILD = '(.+)';").Matches[0].Groups[1].Value
$liveBuild  = $null
try {
  $liveSw = curl.exe -sS --max-time 15 "https://$Domain/sw.js" 2>$null
  if ($liveSw -match "var BUILD = '(.+)';") { $liveBuild = $Matches[1] }
} catch { }
if ($liveBuild -and $liveBuild -eq $localBuild) {
  Write-Host "Build $localBuild is already live. Run ./bump-version.sh first, or this deploy will not reach installed copies." -ForegroundColor Yellow
  if ((Read-Host 'Upload anyway? (y/N)') -ne 'y') { exit 1 }
}

$sec  = Read-Host "FTP password for $User" -AsSecureString
$pass = [System.Net.NetworkCredential]::new('', $sec).Password

function Send-One([string]$local, [string]$rel) {
  curl.exe -sS --ssl-reqd --ftp-create-dirs -u "${User}:${pass}" -T $local "ftp://$FtpHost/$Remote/$rel"
  if ($LASTEXITCODE -ne 0) { throw "upload failed: $rel" }
  Write-Host "  sent  $rel"
}

Write-Host "Uploading build $localBuild to $Domain ..."
foreach ($f in $Files) { Send-One $f $f }
foreach ($d in $Dirs) {
  Get-ChildItem -LiteralPath $d -File -Force | ForEach-Object { Send-One $_.FullName "$d/$($_.Name)" }
}

Write-Host "`nChecking $Domain ..."
$code = curl.exe -sS -o $null -w '%{http_code}' "https://$Domain/"
Write-Host "  https://$Domain/            $code $(if ($code -eq '200') { 'ok' } else { 'NOT 200 — check SSL and the document root in hPanel' })"

$head = curl.exe -sSI "https://$Domain/sw.js"
Write-Host "  sw.js cache-control        $(if ($head -match '(?i)cache-control:\s*no-cache') { 'no-cache — good' } else { 'MISSING — .htaccess did not upload; updates will stall' })"
Write-Host "  noindex header             $(if ((curl.exe -sSI "https://$Domain/") -match '(?i)x-robots-tag') { 'set' } else { 'missing — .htaccess did not upload' })"

$live = curl.exe -sS "https://$Domain/sw.js"
Write-Host "  build live                 $(if ($live -match "var BUILD = '$([regex]::Escape($localBuild))';") { $localBuild } else { 'still the old build — clear your browser cache and re-check' })"
Write-Host "`nOpen https://$Domain/ and unlock with 162007, then change the code in Settings."
