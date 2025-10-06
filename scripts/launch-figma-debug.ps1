# Launch Figma Desktop with Remote Debugging Enabled (Windows)
# This script starts Figma with Chrome Remote Debugging Protocol enabled,
# allowing the Figma Console MCP to capture plugin console logs.

param(
    [int]$DebugPort = 9222
)

$ErrorActionPreference = "Stop"

# Configuration
$FigmaPath = "$env:LOCALAPPDATA\Figma\Figma.exe"

Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host "  Figma Desktop Debug Launcher (Windows)" -ForegroundColor Blue
Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Blue
Write-Host ""

# Check if Figma is installed
if (-not (Test-Path $FigmaPath)) {
    Write-Host "✗ Figma Desktop not found at: $FigmaPath" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Figma Desktop from:"
    Write-Host "  https://www.figma.com/downloads/"
    exit 1
}

# Check if Figma is already running
$figmaProcess = Get-Process -Name "Figma" -ErrorAction SilentlyContinue
if ($figmaProcess) {
    Write-Host "⚠ Figma is already running" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "To enable debug mode, you need to quit and relaunch Figma."
    Write-Host ""
    $response = Read-Host "Do you want to quit Figma and relaunch with debugging? (y/n)"
    if ($response -eq 'y' -or $response -eq 'Y') {
        Write-Host "→ Quitting Figma..." -ForegroundColor Yellow
        Stop-Process -Name "Figma" -Force
        Start-Sleep -Seconds 2
    } else {
        Write-Host "✗ Aborted" -ForegroundColor Red
        exit 1
    }
}

# Launch Figma with remote debugging
Write-Host "→ Launching Figma Desktop with remote debugging..." -ForegroundColor Green
Write-Host "  Debug Port: $DebugPort" -ForegroundColor Blue
Write-Host ""

Start-Process -FilePath $FigmaPath -ArgumentList "--remote-debugging-port=$DebugPort"

# Wait for Figma to start
Write-Host "→ Waiting for Figma to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 3

# Verify debugging is enabled
Write-Host "→ Verifying debug port..." -ForegroundColor Yellow
try {
    $response = Invoke-WebRequest -Uri "http://localhost:$DebugPort/json/version" -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
        Write-Host "✓ Debug port accessible at http://localhost:$DebugPort" -ForegroundColor Green
        Write-Host ""
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
        Write-Host "  Figma Desktop is ready for debugging!" -ForegroundColor Green
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Green
        Write-Host ""
        Write-Host "Next steps:" -ForegroundColor Blue
        Write-Host "  1. Enable Developer VM:"
        Write-Host "     Plugins → Development → Use Developer VM" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "  2. Run your plugin in Figma"
        Write-Host ""
        Write-Host "  3. Start the Figma Console MCP:"
        Write-Host "     npm run dev:local" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "     Or in Claude Desktop, your MCP will automatically connect!"
        Write-Host ""
    }
} catch {
    Write-Host "✗ Failed to verify debug port" -ForegroundColor Red
    Write-Host ""
    Write-Host "Figma may still be starting. Try checking manually:"
    Write-Host "  curl http://localhost:$DebugPort/json/version"
    exit 1
}
