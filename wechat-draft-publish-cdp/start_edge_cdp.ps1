# start_edge_cdp.ps1
# 以调试模式启动 Edge，使 Playwright 可通过 CDP 连接（127.0.0.1:9222）
# ⚠️ 关键：必须显式 --user-data-dir，且不要加 --remote-debugging-address

# 1. 彻底关闭所有 Edge 进程
Get-Process -Name msedge* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4

# 2. 清理可能残留的锁文件（否则调试服务器起不来）
$ud = "$env:LOCALAPPDATA\Microsoft\Edge\User Data"
foreach ($f in @('SingletonLock','SingletonSocket','SingletonCookie','DevToolsActivePort')) {
    $p = Join-Path $ud $f
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
}

# 3. 以调试模式启动（注意：只给端口，不给 address 标志）
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
    -ArgumentList "--user-data-dir=$ud","--remote-debugging-port=9222","--no-first-run"
Write-Output "Launched Edge, waiting for CDP..."
Start-Sleep -Seconds 12

# 4. 验证端口监听
$port = netstat -ano | findstr ":9222" | findstr "LISTENING"
if ($port) { Write-Output "✓ Edge CDP 已监听 127.0.0.1:9222" }
else { Write-Output "✗ 端口未监听，请检查 Edge 路径与锁文件" }

# 5. 提示用户：在此 Edge 窗口打开 mp.weixin.qq.com 并扫码登录
Write-Output "请在打开的 Edge 窗口中访问 https://mp.weixin.qq.com 并扫码登录（若会话已过期）。"
