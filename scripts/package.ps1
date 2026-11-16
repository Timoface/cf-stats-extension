$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'

foreach ($browser in @('chrome', 'firefox')) {
    $source = Join-Path $dist $browser
    if (-not (Test-Path $source)) {
        throw "Missing build folder: $source"
    }
    $zipPath = Join-Path $dist ("cf-stats-plus-{0}.zip" -f $browser)
    if (Test-Path $zipPath) {
        Remove-Item $zipPath -Force
    }

    $zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $files = Get-ChildItem -LiteralPath $source -Recurse -File |
            Sort-Object FullName
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($source.Length + 1) -replace '\\', '/'
            [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip,
                $file.FullName,
                $relative,
                [System.IO.Compression.CompressionLevel]::Optimal
            )
        }
    }
    finally {
        $zip.Dispose()
    }

    $size = [Math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Output ("  {0} zip: {1} KiB" -f $browser, $size)
}
