# Tishe event script: appends every event to a log file.
# Tishe runs it with one line of JSON on stdin (see README.md).
# Tishe waits up to 10 s for a script, so keep it quick.
# Log: $env:TISHE_EVENT_LOG, or %TEMP%\tishe-events.log.

# Read stdin as UTF-8 bytes: Windows PowerShell would decode it with the
# console code page and garble non-English text.
$stdin = New-Object IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($stdin)
$line = [Text.Encoding]::UTF8.GetString($stdin.ToArray()).Trim().TrimStart([char]0xFEFF)
if (-not $line) { exit 0 }

$log = if ($env:TISHE_EVENT_LOG) { $env:TISHE_EVENT_LOG } else { Join-Path $env:TEMP "tishe-events.log" }
$stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Add-Content -Path $log -Value "$stamp $line" -Encoding UTF8
