$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\MessageAPI'
$env:NODE_ENV = 'production'
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
& 'C:\Program Files\nodejs\node.exe' 'C:\MessageAPI\dist\server.js'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
