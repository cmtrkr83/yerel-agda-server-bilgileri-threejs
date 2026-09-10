# KODM File-Share Agent — SERVER2 (Windows) üzerinde çalışır
# Ne yapar: SMB oturumlarını, açık dosyaları ve sistem yükünü
#   http://192.168.41.252:9419/smb adresinden JSON olarak yayınlar.
#
# KURULUM (server2'de yönetici PowerShell):
#   1) Bu dosyayı C:\kodm\agent-server2.ps1 olarak kopyalayın
#   2) Tek seferlik test:  powershell -ExecutionPolicy Bypass -File C:\kodm\agent-server2.ps1
#      (ayrı bir pencerede http://127.0.0.1:9419/smb açılıyorsa tamamdır, pencereyi kapatın)
#   3) Her açılışta otomatik başlasın:
#      schtasks /create /tn "KODM Agent" /tr "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\kodm\agent-server2.ps1" /sc onstart /ru SYSTEM /rl highest /f
#      schtasks /run /tn "KODM Agent"

$Port = 9419
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://+:$Port/smb/")
try { $Listener.Start() } catch { exit 1 }

try {
  New-NetFirewallRule -DisplayName "KODM Monitor Agent" -Direction Inbound `
    -LocalPort $Port -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null
} catch {}

while ($Listener.IsListening) {
  try {
    $ctx = $Listener.GetContext()
    try {
      $sessions = @(Get-SmbSession | Select-Object ClientComputerName, ClientUserName, Dialect, NumOpens)
      $files = @(Get-SmbOpenFile | Select-Object ClientComputerName, ClientUserName, ShareName, Path)
      $tcp = @(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
        Where-Object { $_.RemoteAddress -like '192.168.41.*' } |
        Select-Object @{n='ip';e={$_.RemoteAddress}}, @{n='port';e={$_.LocalPort}})
      $os = Get-CimInstance Win32_OperatingSystem
      $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
      $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
      $drives = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
        Select-Object DeviceID,
          @{n='pct';e={[math]::Round((1 - $_.FreeSpace / $_.Size) * 100)}},
          @{n='freeGB';e={[math]::Round($_.FreeSpace / 1GB, 1)}},
          @{n='sizeGB';e={[math]::Round($_.Size / 1GB, 1)}})
      $shares = @(Get-SmbShare | Where-Object { $_.Name -notmatch '\$$' } | Select-Object Name, Path)
      $ortakPath = ($shares | Where-Object { $_.Name -eq 'ortak' }).Path
      if (-not $script:ortakCacheT -or ((Get-Date) - $script:ortakCacheT).TotalMinutes -gt 30) {
        $script:ortakGB = $null
        if ($ortakPath -and (Test-Path $ortakPath)) {
          $script:ortakGB = [math]::Round((Get-ChildItem $ortakPath -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB, 1)
        }
        $script:ortakCacheT = Get-Date
      }
      $body = @{
        ok = $true
        host = $env:COMPUTERNAME
        at = (Get-Date).ToString('o')
        sessions = $sessions
        files = $files
        conns = $tcp
        system = @{
          cpu = [math]::Round($cpu)
          ram = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100)
          disk = [math]::Round((1 - $disk.FreeSpace / $disk.Size) * 100)
        }
        drives = $drives
        shares = $shares
        ortakGB = $script:ortakGB
        boot = $os.LastBootUpTime.ToString('o')
      } | ConvertTo-Json -Depth 4 -Compress
      $buf = [System.Text.Encoding]::UTF8.GetBytes($body)
      $ctx.Response.ContentType = 'application/json'
      $ctx.Response.ContentLength64 = $buf.Length
      $ctx.Response.OutputStream.Write($buf, 0, $buf.Length)
    } catch { $ctx.Response.StatusCode = 500 }
    $ctx.Response.Close()
  } catch { Start-Sleep -Seconds 2 }
}
