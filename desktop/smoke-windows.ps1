#Requires -Version 7.4

[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [string]$Exe
)

$ErrorActionPreference = 'Stop'
$port = 18787
$root = "http://127.0.0.1:$port"
$exePath = (Resolve-Path -LiteralPath $Exe).ProviderPath
$profilePath = Join-Path ([IO.Path]::GetTempPath()) ("Sitenote-smoke-" + [Guid]::NewGuid().ToString('N'))

function Get-Listeners {
  @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Assert-Status([string]$Route, [int]$Expected, [string]$Origin = '') {
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Get, "$root$Route")
  try {
    if ($Origin) { [void]$request.Headers.TryAddWithoutValidation('Origin', $Origin) }
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    try {
      if ([int]$response.StatusCode -ne $Expected) {
        throw "Expected $Expected for $Route, got $([int]$response.StatusCode)."
      }
    } finally {
      $response.Dispose()
    }
  } finally {
    $request.Dispose()
  }
}

if (@(Get-Listeners).Count -gt 0) { throw "Port $port is already in use." }
Add-Type -AssemblyName System.Net.Http
$handler = [Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$client = [Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(5)
$launcher = $null
$main = $null

try {
  $launcher = Start-Process -FilePath $exePath -ArgumentList "`"--user-data-dir=$profilePath`"" -PassThru -Environment @{
    LOCALAPPDATA = $profilePath
    OPENAI_API_KEY = $null
    SONIOX_API_KEY = $null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    $launcher.Refresh()
    if ($launcher.HasExited) { throw "Portable EXE exited during startup: $($launcher.ExitCode)." }
    $listeners = @(Get-Listeners)
    if ($listeners.Count -gt 0) {
      if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -ne '127.0.0.1') {
        throw "Expected a single IPv4 loopback listener: $($listeners.LocalAddress -join ', ')."
      }
      $ownerId = [int]$listeners[0].OwningProcess
      $details = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId"
      if ($null -eq $details -or $details.ParentProcessId -ne $launcher.Id -or $details.Name -ne 'Sitenote.exe') {
        throw "Unexpected process $ownerId owns the loopback server."
      }
      $main = Get-Process -Id $ownerId
      $main.Refresh()
      # Require the title from the loaded HTML ('Sitenote · …'), not the default BrowserWindow title.
      if ($main.MainWindowHandle -ne [IntPtr]::Zero -and $main.MainWindowTitle -like 'Sitenote *') { break }
    }
    Start-Sleep -Milliseconds 400
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($null -eq $main -or $main.MainWindowHandle -eq [IntPtr]::Zero -or $main.MainWindowTitle -notlike 'Sitenote *') {
    throw 'The packaged SiteNote window did not open.'
  }

  # Electron authenticates its navigation internally. External clients must not get the UI or API.
  Assert-Status '/' 403
  Assert-Status '/health' 403
  Assert-Status '/__sitenote/ready' 403 'https://example.invalid'

  if (!$main.CloseMainWindow()) { throw 'Failed to close the SiteNote window.' }
  if (!$main.WaitForExit(20000)) { throw 'SiteNote did not exit after its window was closed.' }
  if (!$launcher.WaitForExit(20000)) { throw 'The portable launcher did not exit after SiteNote closed.' }
  if ($launcher.ExitCode -ne 0) { throw "Portable EXE exited with code $($launcher.ExitCode)." }
  if (@(Get-Listeners).Count -gt 0) { throw 'The loopback server remained open after exit.' }

  $sha = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
  Write-Output "Windows smoke passed: SiteNote window, protected loopback server, clean exit. SHA256=$sha"
} finally {
  if ($null -ne $main -and !$main.HasExited) {
    Stop-Process -Id $main.Id -Force -ErrorAction SilentlyContinue
    [void]$main.WaitForExit(5000)
  }
  if ($null -ne $launcher -and !$launcher.HasExited -and !$launcher.WaitForExit(5000)) {
    Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue
  }
  $client.Dispose()
  if (Test-Path -LiteralPath $profilePath) {
    Remove-Item -LiteralPath $profilePath -Force -Recurse -ErrorAction SilentlyContinue
  }
}
