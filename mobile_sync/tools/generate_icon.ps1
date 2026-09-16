# Genera el icono de la app (veamosTVSync) a 1024x1024 PNG.
# Uso: powershell -ExecutionPolicy Bypass -File tools/generate_icon.ps1
# Requiere System.Drawing (disponible en Windows PowerShell 5.1).

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\assets\icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

# ── Fondo: rectángulo redondeado con gradiente de marca (135° #667eea → #764ba2) ──
$cx = [double]($size / 2)
$r = 220
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = (2 * $r)
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc(($size - $d), 0, $d, $d, 270, 90)
$path.AddArc(($size - $d), ($size - $d), $d, $d, 0, 90)
$path.AddArc(0, ($size - $d), $d, $d, 90, 90)
$path.CloseFigure()

$rect1 = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect1, `
  [System.Drawing.Color]::FromArgb(255, 102, 126, 234), `
  [System.Drawing.Color]::FromArgb(255, 118, 75, 162), `
  [System.Drawing.Drawing2D.LinearGradientMode]::ForwardDiagonal)
$g.FillPath($bgBrush, $path)

$edgePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(50, 255, 255, 255), 2)
$g.DrawPath($edgePen, $path)

# ── Resplandor superior (glossy) ──
$glossH = [int]($size * 0.42)
$glossPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$dr = 200
$glossPath.AddArc(20, 14, $dr, $dr, 180, 90)
$glossPath.AddArc(($size - 20 - $dr), 14, $dr, $dr, 270, 90)
$glossPath.AddArc(($size - 20 - $dr), (14 + $glossH), $dr, $dr, 0, 90)
$glossPath.AddArc(20, (14 + $glossH), $dr, $dr, 90, 90)
$glossPath.CloseFigure()

$rect2 = New-Object System.Drawing.RectangleF(20, 14, ($size - 40), $glossH)
$gloss = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect2, `
  [System.Drawing.Color]::FromArgb(55, 255, 255, 255), `
  [System.Drawing.Color]::FromArgb(0, 255, 255, 255), `
  [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
$g.FillPath($gloss, $glossPath)

# ── Anillo (play + sync) ──
$ringPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 30)
$ringPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$ringPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawEllipse($ringPen, ($cx - 250), ($cx - 250), 500, 500)

# ── Triángulo de play ──
$triPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 30)
$triPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$triPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$play = [System.Drawing.PointF[]]@(
  (New-Object System.Drawing.PointF(395, 385)),
  (New-Object System.Drawing.PointF(395, 639)),
  (New-Object System.Drawing.PointF(655, 512))
)
$g.DrawLines($triPen, $play)

# ── Puntos de sincronización sobre el anillo ──
$dotBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$g.FillEllipse($dotBrush, ($cx - 34), ($cx - 298), 68, 68)
$g.FillEllipse($dotBrush, ($cx + 264), ($cx - 34), 68, 68)

$g.Dispose()

$target = Join-Path $outDir 'app_icon.png'
$bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Icono generado: $target ($((Get-Item $target).Length) bytes)"

$preview = New-Object System.Drawing.Bitmap(256, 256)
$pg = [System.Drawing.Graphics]::FromImage($preview)
$pg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$pg.DrawImage($bmp, 0, 0, 256, 256)
$pg.Dispose()
$previewTarget = Join-Path $outDir 'app_icon_preview.png'
$preview.Save($previewTarget, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Preview: $previewTarget"
$bmp.Dispose()
$preview.Dispose()