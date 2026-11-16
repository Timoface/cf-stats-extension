Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedPath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-Icon {
    param([int]$Size, [string]$Path)

    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $radius = [Math]::Max(2.0, $Size * 0.22)
    $backgroundPath = New-RoundedPath -X 0 -Y 0 -Width $Size -Height $Size -Radius $radius
    $startColor = [System.Drawing.Color]::FromArgb(255, 59, 130, 246)
    $endColor = [System.Drawing.Color]::FromArgb(255, 30, 64, 175)
    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF($Size, $Size)),
        $startColor,
        $endColor
    )
    $graphics.FillPath($gradient, $backgroundPath)

    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
    $barWidth = [float]($Size * 0.145)
    $gap = [float]($Size * 0.085)
    $baseY = [float]($Size * 0.78)
    $left = [float]($Size * 0.205)
    $heights = @([float]($Size * 0.29), [float]($Size * 0.45), [float]($Size * 0.60))
    $barRadius = [Math]::Max(0.8, $Size * 0.032)

    for ($i = 0; $i -lt 3; $i++) {
        $x = $left + $i * ($barWidth + $gap)
        $height = $heights[$i]
        $y = $baseY - $height
        $barPath = New-RoundedPath -X $x -Y $y -Width $barWidth -Height $height -Radius $barRadius
        $graphics.FillPath($white, $barPath)
        $barPath.Dispose()
    }

    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)

    $white.Dispose()
    $gradient.Dispose()
    $backgroundPath.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

foreach ($size in @(16, 32, 48, 128)) {
    $path = Join-Path $outDir ("icon{0}.png" -f $size)
    New-Icon -Size $size -Path $path
    Write-Output ("created {0}" -f $path)
}
