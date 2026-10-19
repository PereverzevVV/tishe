# Tishe event script: shows transcription progress in Coucou
# (https://github.com/Louis-CFM/coucou), the island for AI agent sessions.
#
# Events go through Coucou's own relay, coucou-hook.exe, as an agent called
# "handy". If Coucou isn't installed or isn't running, this does nothing.
# Relay location: $env:COUCOU_HOOK, or where Coucou puts it.

$hook = if ($env:COUCOU_HOOK) { $env:COUCOU_HOOK } else { Join-Path $env:LOCALAPPDATA "Coucou\bin\coucou-hook.exe" }
if (-not (Test-Path $hook)) { exit 0 }

# Read stdin as UTF-8 bytes: Windows PowerShell would decode it with the
# console code page and garble non-English text.
$stdin = New-Object IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($stdin)
$line = [Text.Encoding]::UTF8.GetString($stdin.ToArray()).Trim().TrimStart([char]0xFEFF)
if (-not $line) { exit 0 }
$data = $line | ConvertFrom-Json

$file = if ($data.file) { Split-Path $data.file -Leaf } else { "Tishe" }

# Tishe events -> Coucou hook events. The job starts with the file name as its
# first line; "Progress" then rewrites one line under it, so a 30-minute job
# stays two lines: the file, and where it is.
$name = switch ($data.event) {
    "started"   { "UserPromptSubmit" }
    "progress"  { "Progress" }
    "finished"  { "Stop" }
    "test"      { "Stop" }
    "failed"    { "StopFailure" }
    "cancelled" { "SessionEnd" }
    default     { exit 0 }
}

$text = if ($data.event -eq "started") { $file } else { $data.message }
$payload = @{
    hook_event_name = $name
    cwd             = if ($data.file) { Split-Path $data.file -Parent } else { "" }
    prompt          = $text
    message         = $text
} | ConvertTo-Json -Compress

$OutputEncoding = [Text.UTF8Encoding]::new($false)
$payload | & $hook --agent handy
