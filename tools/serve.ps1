#Requires -Version 5.1
<#
    Zero-dependency static file server for the gaokaoshun preview.

    Why this exists: the app is built from ES modules, and browsers refuse to
    load modules over file://. This script serves the project folder over
    http://127.0.0.1:<port>/ using nothing but System.Net.Sockets, so it works
    on a clean Windows box with no Node.js / Python installed.

    It also exposes two small JSON endpoints:

        GET  /api/data-index      list files under data/ (auto-load in the app)
        POST /api/append-csv      merge rows into data/<file>.csv

    The POST one is how the browser collector gets its data onto disk without
    the user dragging files around. Payload:

        {
          "file": "xxx.csv",            // must be a plain file name
          "header": "<csv header line>",   // used verbatim
          "rows":  ["\"2024\",...", ...], // data lines, merged by key
          "keyColumns": [0, 2, 5]        // which cells form the merge key
        }

    NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads
    .ps1 as ANSI, so any literal CJK here would be mangled.

    Usage:
        powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 9000
#>
param(
    [int]$Port = 8137,
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
$Root = [System.IO.Path]::GetFullPath($Root)
if (-not (Test-Path -LiteralPath $Root)) {
    Write-Host "Project root not found: $Root" -ForegroundColor Red
    exit 1
}

$mimeMap = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.mjs'  = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.ico'  = 'image/x-icon'
    '.csv'  = 'text/csv; charset=utf-8'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/markdown; charset=utf-8'
    '.xlsx' = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    '.xls'  = 'application/vnd.ms-excel'
    '.woff2' = 'font/woff2'
}

function Send-Response {
    param(
        [System.IO.Stream]$Stream,
        [int]$Status,
        [string]$Reason,
        [string]$ContentType,
        [byte[]]$Body,
        [bool]$HeadOnly = $false,
        [bool]$Cors = $false
    )

    if ($null -eq $Body) { $Body = New-Object byte[] 0 }
    $corsHeader = ''
    if ($Cors) {
        # The collector runs on www.gaokao.cn; Allow-Private-Network is what
        # Chrome wants when a public page talks to a loopback server.
        $corsHeader = "Access-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type`r`nAccess-Control-Allow-Private-Network: true`r`n"
    }
    $header = "HTTP/1.1 $Status $Reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`n${corsHeader}Cache-Control: no-cache`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if (-not $HeadOnly -and $Body.Length -gt 0) {
        $Stream.Write($Body, 0, $Body.Length)
    }
    $Stream.Flush()
}

# Split one CSV line into cells, honouring double quotes.
function Split-CsvLine([string]$Line) {
    $cells = New-Object System.Collections.ArrayList
    $sb = New-Object System.Text.StringBuilder
    $quoted = $false
    for ($i = 0; $i -lt $Line.Length; $i++) {
        $ch = $Line[$i]
        if ($quoted) {
            if ($ch -eq '"' -and $i + 1 -lt $Line.Length -and $Line[$i + 1] -eq '"') { [void]$sb.Append('"'); $i++ }
            elseif ($ch -eq '"') { $quoted = $false }
            else { [void]$sb.Append($ch) }
        }
        elseif ($ch -eq '"') { $quoted = $true }
        elseif ($ch -eq ',') { [void]$cells.Add($sb.ToString()); [void]$sb.Clear() }
        else { [void]$sb.Append($ch) }
    }
    [void]$cells.Add($sb.ToString())
    return , $cells
}

# Build the merge key from the given column indexes.
function Get-RowKey([string]$Line, $KeyCols) {
    $cells = Split-CsvLine $Line
    $parts = foreach ($idx in $KeyCols) {
        $i = [int]$idx
        if ($i -ge 0 -and $i -lt $cells.Count) { $cells[$i] } else { '' }
    }
    return ($parts -join '|')
}

# POST /api/append-csv body -> write merged file, return JSON result object.
function Invoke-AppendCsv([string]$BodyText, [string]$DataRoot) {
    $result = [pscustomobject]@{ ok = $false; message = ''; rows = 0; added = 0; file = '' }
    try {
        $payload = $BodyText | ConvertFrom-Json
        $fileName = [string]$payload.file
        $headerLine = [string]$payload.header
        $rowsIn = @($payload.rows)
        $keyCols = @($payload.keyColumns)

        if ([string]::IsNullOrWhiteSpace($fileName)) { throw 'payload missing file' }
        if ([string]::IsNullOrWhiteSpace($headerLine)) { throw 'payload missing header' }
        if ($keyCols.Count -eq 0) { throw 'payload missing keyColumns' }
        if ($fileName -notmatch '^[^\\/:*?"<>|]+\.csv$') { throw 'bad file name' }

        $dataDir = Join-Path $DataRoot 'data'
        if (-not (Test-Path -LiteralPath $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
        $target = Join-Path $dataDir $fileName

        $merged = [ordered]@{}
        $added = 0

        if (Test-Path -LiteralPath $target) {
            $oldLines = @([System.IO.File]::ReadAllLines($target, [System.Text.Encoding]::UTF8))
            foreach ($ln in $oldLines) {
                if ([string]::IsNullOrWhiteSpace($ln)) { continue }
                if ($ln.StartsWith($headerLine)) { continue }
                $k = Get-RowKey $ln $keyCols
                if ($k) { $merged[$k] = $ln }
            }
        }
        foreach ($ln in $rowsIn) {
            if ([string]::IsNullOrWhiteSpace($ln)) { continue }
            $k = Get-RowKey $ln $keyCols
            if (-not $k) { continue }
            if (-not $merged.Contains($k)) { $added++ }
            $merged[$k] = $ln
        }

        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append($headerLine + "`r`n")
        foreach ($ln in $merged.Values) { [void]$sb.Append($ln + "`r`n") }
        $enc = New-Object System.Text.UTF8Encoding($true)
        [System.IO.File]::WriteAllText($target, $sb.ToString(), $enc)

        $result.ok = $true
        $result.message = 'ok'
        $result.rows = $merged.Count
        $result.added = $added
        $result.file = $target
    }
    catch {
        $msg = $_.Exception.Message
        # A very common case: the CSV is open in Excel, so the write is denied.
        # Say so plainly instead of dumping a .NET exception.
        # PowerShell wraps the real error in a MethodInvocationException,
        # so walk the inner chain and test the actual exception type.
        $inner = $_.Exception
        while ($inner.InnerException) { $inner = $inner.InnerException }
        $isIo = ($inner -is [System.IO.IOException]) -or ($inner -is [System.UnauthorizedAccessException]) -or ($_.Exception -is [System.IO.IOException])
        if ($isIo -or $msg -match 'being used|denied|EPERM') {
            $result.message = 'file is locked by another program (close Excel / editor and it will retry)'
        }
        else {
            $result.message = $msg
        }
    }
    return $result
}

try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
}
catch {
    Write-Host "Cannot listen on port $Port : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Try another port:  powershell -File tools\serve.ps1 -Port 9000" -ForegroundColor Yellow
    exit 1
}

$url = "http://127.0.0.1:$Port/"
Write-Host ''
Write-Host "  gaokaoshun preview" -ForegroundColor Cyan
Write-Host "  URL : $url" -ForegroundColor Green
Write-Host "  Root: $Root"
Write-Host ''
Write-Host '  Press Ctrl+C to stop.' -ForegroundColor DarkGray
Write-Host ''

try {
    Start-Process $url | Out-Null
}
catch {
    Write-Host "  (Could not open the browser automatically - please open the URL manually.)" -ForegroundColor Yellow
}

while ($true) {
    $client = $null
    try {
        $client = $listener.AcceptTcpClient()
        $client.ReceiveTimeout = 15000
        $stream = $client.GetStream()

        # Read raw bytes until the blank line ending the headers.
        # Do NOT use StreamReader: it buffers ahead and swallows part of a POST
        # body, which then blocks the later read forever.
        $buf = New-Object System.Collections.Generic.List[byte]
        $chunk = New-Object byte[] 4096
        $headerEnd = -1
        while ($headerEnd -lt 0) {
            $n = $stream.Read($chunk, 0, $chunk.Length)
            if ($n -le 0) { break }
            for ($i = 0; $i -lt $n; $i++) { [void]$buf.Add($chunk[$i]) }
            for ($i = 3; $i -lt $buf.Count; $i++) {
                if ($buf[$i - 3] -eq 13 -and $buf[$i - 2] -eq 10 -and $buf[$i - 1] -eq 13 -and $buf[$i] -eq 10) {
                    $headerEnd = $i - 3
                    break
                }
            }
        }
        if ($headerEnd -lt 0) { continue }

        $rawHead = $buf.ToArray()
        $headerText = [System.Text.Encoding]::ASCII.GetString($rawHead, 0, $headerEnd)
        $headerLines = $headerText -split "`r`n"
        $requestLine = $headerLines[0]
        if ([string]::IsNullOrWhiteSpace($requestLine)) { continue }

        $headers = @{}
        for ($i = 1; $i -lt $headerLines.Count; $i++) {
            $line = $headerLines[$i]
            $ci = $line.IndexOf(':')
            if ($ci -gt 0) {
                $hName = $line.Substring(0, $ci).Trim().ToLowerInvariant()
                $headers[$hName] = $line.Substring($ci + 1).Trim()
            }
        }
        $bodyStart = $headerEnd + 4

        $parts = $requestLine -split ' '
        if ($parts.Length -lt 2) { continue }
        $method = $parts[0].ToUpperInvariant()
        $rawPath = $parts[1]

        $headOnly = $method -eq 'HEAD'

        $queryIndex = $rawPath.IndexOf('?')
        if ($queryIndex -ge 0) { $rawPath = $rawPath.Substring(0, $queryIndex) }
        $decoded = [System.Uri]::UnescapeDataString($rawPath)

        if ($method -eq 'OPTIONS') {
            Send-Response -Stream $stream -Status 204 -Reason 'No Content' -ContentType 'text/plain; charset=utf-8' -Body $null -Cors $true
            continue
        }

        if ($method -eq 'POST' -and $decoded -eq '/api/append-csv') {
            $len = 0
            if ($headers['content-length']) { [int]::TryParse($headers['content-length'], [ref]$len) | Out-Null }
            $bodyText = ''
            if ($len -gt 0) {
                $bodyBytes = New-Object byte[] $len
                $have = $rawHead.Length - $bodyStart
                $read = 0
                if ($have -gt 0) {
                    $copy = [Math]::Min($have, $len)
                    [Array]::Copy($rawHead, $bodyStart, $bodyBytes, 0, $copy)
                    $read = $copy
                }
                while ($read -lt $len) {
                    $n = $stream.Read($bodyBytes, $read, $len - $read)
                    if ($n -le 0) { break }
                    $read += $n
                }
                $bodyText = [System.Text.Encoding]::UTF8.GetString($bodyBytes, 0, $read)
            }
            $result = Invoke-AppendCsv -BodyText $bodyText -DataRoot $Root
            $json = $result | ConvertTo-Json -Compress
            Send-Response -Stream $stream -Status 200 -Reason 'OK' -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -Cors $true
            continue
        }

        if ($method -ne 'GET' -and -not $headOnly) {
            Send-Response -Stream $stream -Status 405 -Reason 'Method Not Allowed' -ContentType 'text/plain; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('405'))
            continue
        }

        # The app uses this endpoint to auto-discover files under data/.
        # \u8f6f\u79d1 is the school-list CSV prefix (kept escaped: ASCII-only file).
        if ($decoded -eq '/api/data-index') {
            $dataDir = Join-Path $Root 'data'
            $files = New-Object System.Collections.ArrayList
            if (Test-Path -LiteralPath $dataDir) {
                Get-ChildItem -LiteralPath $dataDir -Recurse -File -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.Extension -match '^\.(xlsx|xls|csv)$' -and
                        $_.Name -notmatch '^(?:\u8f6f\u79d1|schools|README)'
                    } |
                    ForEach-Object {
                        $rel = $_.FullName.Substring($dataDir.Length).TrimStart('\', '/').Replace('\', '/')
                        [void]$files.Add([pscustomobject]@{
                            rel   = $rel
                            size  = $_.Length
                            mtime = [int64]([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds()
                        })
                    }
            }
            $sorted = @($files | Sort-Object rel)
            $sig = "{0}:{1}:{2}" -f $sorted.Count, ($sorted | Measure-Object -Property size -Sum).Sum, (($sorted | Measure-Object -Property mtime -Maximum).Maximum)
            if (-not $sig) { $sig = '0:0:0' }
            $json = [pscustomobject]@{ files = $sorted; signature = $sig } | ConvertTo-Json -Depth 4 -Compress
            Send-Response -Stream $stream -Status 200 -Reason 'OK' -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -HeadOnly $headOnly
            continue
        }

        if ($decoded -eq '/' -or $decoded.EndsWith('/')) { $decoded += 'index.html' }

        $relative = $decoded.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $target = [System.IO.Path]::GetFullPath((Join-Path $Root $relative))

        # Directory traversal guard
        if (-not $target.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
            Send-Response -Stream $stream -Status 403 -Reason 'Forbidden' -ContentType 'text/plain; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes('403'))
            continue
        }

        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $decoded")
            Send-Response -Stream $stream -Status 404 -Reason 'Not Found' -ContentType 'text/plain; charset=utf-8' -Body $body -HeadOnly $headOnly
            continue
        }

        $extension = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
        $contentType = $mimeMap[$extension]
        if (-not $contentType) { $contentType = 'application/octet-stream' }

        $bytes = [System.IO.File]::ReadAllBytes($target)
        Send-Response -Stream $stream -Status 200 -Reason 'OK' -ContentType $contentType -Body $bytes -HeadOnly $headOnly
    }
    catch {
        # A broken client connection must never kill the server loop.
    }
    finally {
        if ($client) { $client.Close() }
    }
}
