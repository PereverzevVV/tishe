# Download the pinned llama.cpp CPU build into src-tauri/llama-runtime/.
#
# Tishe bundles llama-server.exe (plus its own ggml DLLs) as a separate
# helper process for the built-in local LLM. It runs out-of-process because
# transcribe-cpp ships its own, different ggml DLLs under the same names.
#
# Run once before `bun run tauri dev` / `bun run tauri build`:
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-llama.ps1

$ErrorActionPreference = "Stop"

$Tag = "b11415"
$Asset = "llama-$Tag-bin-win-cpu-x64.zip"
$Sha256 = "2d96c8540f978638a8f64bc90e87c94ed16e8ccef6e62798007e9ce3f181d8cd"
$Url = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag/$Asset"

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "src-tauri\llama-runtime"
$Stamp = Join-Path $Dest ".version"

if ((Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $Tag)) {
    Write-Host "llama.cpp $Tag is already in $Dest"
    exit 0
}

$Zip = Join-Path $env:TEMP $Asset
Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

$Actual = (Get-FileHash -Algorithm SHA256 $Zip).Hash.ToLower()
if ($Actual -ne $Sha256) {
    Remove-Item $Zip -Force
    throw "SHA-256 mismatch for $Asset (got $Actual)"
}

if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
$Unpacked = Join-Path $env:TEMP "llama-$Tag-unpacked"
if (Test-Path $Unpacked) { Remove-Item -Recurse -Force $Unpacked }
Expand-Archive -Path $Zip -DestinationPath $Unpacked
New-Item -ItemType Directory -Force $Dest | Out-Null

# Only the server and the libraries it loads; the other CLI tools are not needed.
$Server = Get-ChildItem -Path $Unpacked -Recurse -Filter "llama-server.exe" | Select-Object -First 1
if (-not $Server) { throw "llama-server.exe not found in $Asset" }
Copy-Item $Server.FullName $Dest
$Unused = "llama-(batched-bench|bench|cli|completion|perplexity|quantize)-impl\.dll"
Get-ChildItem -Path $Server.DirectoryName -Filter "*.dll" |
    Where-Object { $_.Name -notmatch $Unused } |
    Copy-Item -Destination $Dest
Get-ChildItem -Path $Unpacked -Recurse -Filter "LICENSE*" | Select-Object -First 1 |
    Copy-Item -Destination (Join-Path $Dest "LICENSE-llama.cpp.txt")

Set-Content -Path $Stamp -Value $Tag -NoNewline
Remove-Item -Recurse -Force $Unpacked
Remove-Item $Zip -Force
Write-Host "llama.cpp $Tag installed into $Dest"
Get-ChildItem $Dest | Format-Table Name, Length
