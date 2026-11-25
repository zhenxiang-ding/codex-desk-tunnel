# Installs cxdt, the terminal client of Codex Desk Tunnel, for the current user, in Windows PowerShell or PowerShell 7:
#
#   irm https://raw.githubusercontent.com/zhenxiang-ding/codex-desk-tunnel/main/deploy/install-cxdt.ps1 | iex
#
# It downloads the Windows package of the newest release, checks it against the release's SHA256SUMS and puts it in
# place with the install script the package carries, which adds cxdt to the user's PATH; this window can use it at
# once. No administrator rights are needed. $env:CXDT_VERSION = '0.1.0' takes that release instead, the one of the
# service; $env:CXDT_DOWNLOAD_ONLY = '1' only unpacks the checked package into the current folder.
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell draws a progress bar for every block it downloads, which makes a large file slow.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $repository = 'zhenxiang-ding/codex-desk-tunnel'
  $version = $env:CXDT_VERSION
  if (-not $version) {
    $version = (Invoke-RestMethod "https://api.github.com/repos/$repository/releases/latest").tag_name
  }
  $tag = if ($version -match '^(codex-)?v') { $version } elseif ($version -eq '0.3.20') { "codex-v$version" } else { "v$version" }
  $base = "https://github.com/$repository/releases/download/$tag"
  $version = $tag -replace '^(codex-)?v', ''
  # UI-only releases keep the same client/server compatibility version.
  $version = $version -replace '-ui\.[0-9]+$', ''
  $name = "cxdt-$version-windows-x64.zip"
  $folder = Join-Path ([IO.Path]::GetTempPath()) "cxdt-install-$(Get-Random)"
  New-Item -ItemType Directory $folder | Out-Null
  try {
    Write-Host "正在下载 cxdt $version ……"
    $archive = Join-Path $folder $name
    $sums = Join-Path $folder 'SHA256SUMS'
    try {
      Invoke-WebRequest "$base/$name" -OutFile $archive -UseBasicParsing
      Invoke-WebRequest "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    } catch {
      throw "下载 cxdt $version 失败：$($_.Exception.Message)。请确认版本号与网络；需要代理时先设置系统代理。"
    }
    $expected = Get-Content $sums | ForEach-Object {
      $fields = $_.Trim() -split '\s+'
      if ($fields[1] -eq $name -or $fields[1] -eq "*$name") { $fields[0] }
    } | Select-Object -First 1
    if (-not $expected) { throw "$version 的校验清单里没有 $name。" }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) {
      throw "下载的 $name 校验不符，没有安装。"
    }
    # The system's own tar, which reads .zip; another one may come first on the PATH.
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if ($env:CXDT_DOWNLOAD_ONLY) {
      & $tar -xf $archive -C (Get-Location).Path
      if ($LASTEXITCODE) { throw '解压失败。' }
      Write-Host "已校验并解压到 $(Join-Path (Get-Location).Path 'cxdt')，没有安装。"
      return
    }
    & $tar -xf $archive -C $folder
    if ($LASTEXITCODE) { throw '解压失败。' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $folder 'cxdt\install.ps1')
    if ($LASTEXITCODE) { throw '安装脚本没有完成。' }
    # The install script added cxdt to the user's PATH, which windows opened from now on read; this one is told too.
    $target = Join-Path $env:LOCALAPPDATA 'Programs\cxdt'
    if (-not (($env:Path -split ';') -contains $target)) { $env:Path = "$env:Path;$target" }
    Write-Host '这个窗口里也可以直接运行 cxdt 了。'
  } finally {
    Remove-Item -Recurse -Force $folder -ErrorAction SilentlyContinue
  }
}