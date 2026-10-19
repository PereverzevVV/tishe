# Download the pinned LGPL build of FFmpeg into src-tauri/ffmpeg-runtime/.
#
# Tishe bundles ffmpeg.exe so that file transcription works without a
# separate ffmpeg install. It runs as a separate process (never linked into
# Tishe), so the LGPL covers only ffmpeg itself. The LGPL asks us to ship its
# license text and to point to the source code of this exact build: both are
# written next to ffmpeg.exe (LICENSE.txt, SOURCE.txt).
#
# The build is BtbN/FFmpeg-Builds "win64-lgpl" (static, LGPL v3, includes the
# libmp3lame encoder that Tishe uses for the MP3 fragments). Not the gyan.dev
# "essentials" build: that one is GPL.
#
# BtbN deletes its dated builds after about a month, so the first URL is our
# own copy in the Tishe "build-deps" release; upload the same zip there
# (DOCUMENTATION §8). The SHA-256 below is the trust anchor for both URLs.
#
# Run once before `bun run tauri dev` / `bun run tauri build`:
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1

$ErrorActionPreference = "Stop"

$Version = "n8.1.3-18-g46d899d7a0"
$Asset = "ffmpeg-$Version-win64-lgpl-8.1.zip"
$Sha256 = "c24a70265bbf2089b8a4dcbe988049352e781425eb022427e63189c6e4038391"
$Urls = @(
    "https://github.com/PereverzevVV/tishe/releases/download/build-deps/$Asset",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-14-13-03/$Asset"
)
# Source code of this exact build (LGPL): FFmpeg at the commit in the version
# string, built by the BtbN scripts at the commit of that autobuild.
$FfmpegCommit = "46d899d7a02bc63237472cc4897258d5ddf274ac"
$BuildScriptsCommit = "63ac3265b0789ea16c7b1f8351cd2ad195a28722"

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "src-tauri\ffmpeg-runtime"
$Stamp = Join-Path $Dest ".version"

if ((Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $Version)) {
    Write-Host "FFmpeg $Version is already in $Dest"
    exit 0
}

$Zip = Join-Path $env:TEMP $Asset
$Downloaded = $false
foreach ($Url in $Urls) {
    try {
        Write-Host "Downloading $Url"
        Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
        $Downloaded = $true
        break
    } catch {
        Write-Host "  failed: $($_.Exception.Message)"
    }
}
if (-not $Downloaded) { throw "Could not download $Asset from any URL" }

$Actual = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower()
if ($Actual -ne $Sha256) {
    Remove-Item $Zip -Force
    throw "SHA-256 mismatch for $Asset (got $Actual)"
}

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
$Unpacked = Join-Path $env:TEMP "ffmpeg-$Version-unpacked"
if (Test-Path $Unpacked) { Remove-Item -Recurse -Force $Unpacked }
Expand-Archive -Path $Zip -DestinationPath $Unpacked
New-Item -ItemType Directory -Force $Dest | Out-Null

# Only ffmpeg.exe: Tishe does not use ffprobe or ffplay.
$Exe = Get-ChildItem -Path $Unpacked -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $Exe) { throw "ffmpeg.exe not found in $Asset" }
Copy-Item $Exe.FullName $Dest
# The LGPL text must ship next to ffmpeg.exe: fail rather than build without it.
$License = Get-ChildItem -Path $Unpacked -Recurse -Filter "LICENSE.txt" | Select-Object -First 1
if (-not $License) { throw "LICENSE.txt not found in $Asset" }
Copy-Item $License.FullName (Join-Path $Dest "LICENSE.txt")

@"
FFmpeg $Version, win64, LGPL v3 build (static)

Tishe runs this ffmpeg.exe as a separate program to read audio and video
files. It is not linked into Tishe. FFmpeg is licensed under the GNU Lesser
General Public License version 3 (LICENSE.txt in this folder).

Binary: $Asset
  from https://github.com/BtbN/FFmpeg-Builds (release autobuild-2026-10-14-13-03)
  SHA-256 $Sha256

Source code of this build:
  FFmpeg:  https://github.com/FFmpeg/FFmpeg/tree/$FfmpegCommit
           (tarball: https://github.com/FFmpeg/FFmpeg/archive/$FfmpegCommit.tar.gz)
  Build scripts with the exact versions of all bundled libraries:
           https://github.com/BtbN/FFmpeg-Builds/tree/$BuildScriptsCommit
  Copies:  https://github.com/PereverzevVV/tishe/releases/tag/build-deps
"@ | Set-Content -Path (Join-Path $Dest "SOURCE.txt") -Encoding UTF8

Set-Content -Path $Stamp -Value $Version -NoNewline
Remove-Item -Recurse -Force $Unpacked
Remove-Item $Zip -Force
Write-Host "FFmpeg $Version installed into $Dest"
Get-ChildItem $Dest | Format-Table Name, Length
