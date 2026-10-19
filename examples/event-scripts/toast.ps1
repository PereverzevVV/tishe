# Tishe event script: a Windows notification when a file is done or fails.
# Needs Windows PowerShell 5.1 (what Tishe uses for .ps1); no extra modules.

# Read stdin as UTF-8 bytes: Windows PowerShell would decode it with the
# console code page and garble non-English text.
$stdin = New-Object IO.MemoryStream
[Console]::OpenStandardInput().CopyTo($stdin)
$line = [Text.Encoding]::UTF8.GetString($stdin.ToArray()).Trim().TrimStart([char]0xFEFF)
if (-not $line) { exit 0 }
$data = $line | ConvertFrom-Json
if ($data.event -notin @("finished", "failed", "test")) { exit 0 }

$file = if ($data.file) { Split-Path $data.file -Leaf } else { "Tishe" }
$text = if ($data.event -eq "finished" -and $data.output_path) { $data.output_path } else { $data.message }

[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$lines = $template.GetElementsByTagName("text")
$lines.Item(0).AppendChild($template.CreateTextNode("$file - $($data.message)")) | Out-Null
$lines.Item(1).AppendChild($template.CreateTextNode($text)) | Out-Null

# Windows only shows toasts from registered apps; Windows PowerShell is one.
$appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show(
    [Windows.UI.Notifications.ToastNotification]::new($template))
