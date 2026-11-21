param(
    [string]$Title = 'Peripheral battery',
    [string]$Body = 'A wireless peripheral is running low.',
    [string]$AppId = 'com.deepseek.dsh'
)

# Windows Toast via WinRT. Requires Windows PowerShell 5.1 (pwsh 7 cannot load
# the WinRT type projections). The AUMID must be registered in the Start menu;
# DeepSeek Harness registers `com.deepseek.dsh` during installation.
$ErrorActionPreference = 'Stop'

$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
    [Windows.UI.Notifications.ToastTemplateType]::ToastText02
)
$texts = $xml.GetElementsByTagName('text')
$texts.Item(0).AppendChild($xml.CreateTextNode($Title)) | Out-Null
$texts.Item(1).AppendChild($xml.CreateTextNode($Body)) | Out-Null

$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = 'peripheral-battery-low'
$toast.Group = 'peripheral-battery'

$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId)
$notifier.Show($toast)
