# ============================================================
# Deploy a Google Cloud Run (servicio de respaldo / último recurso)
# IMPORTANTE:
#   - El principal sigue siendo App Hosting (apphosting.yaml).
#   - Cloud Run solo se usa para extracción con Chromium cuando la
#     extracción normal de App Hosting falla.
#   - PUBLIC_BASE_URL en Cloud Run DEBE ser la URL propia del servicio
#     (*.run.app), porque el proxy de los streams extraídos aquí debe
#     correr en la MISMA IP que generó el token. Pásala con -PublicBaseUrl
#     o configúrala después del primer deploy (mira el recordatorio final).
# Requisitos:
#   - gcloud CLI autenticado y proyecto veamos-tv activo
#   - Secretos en Secret Manager: JWT_SECRET, FALLBACK_EXTRACT_KEY
#   - Permiso Firestore a la cuenta de servicio (ver final)
#
# Uso:
#   .\deploy-cloudrun.ps1 -PublicBaseUrl "https://veamos-tv-backend-XXXX-uc.a.run.app"
# ============================================================

param(
  [string]$Region = "us-central1",
  [string]$Service = "veamos-tv-backend",
  [string]$PublicBaseUrl = "",
  [string]$Memory = "2Gi",
  [int]$Cpu = 2,
  [int]$Concurrency = 20,
  [int]$MinInstances = 1,
  [int]$MaxInstances = 3,
  [int]$TimeoutSec = 300
)

$ErrorActionPreference = "Stop"

gcloud config set project veamos-tv

# PORT no se pasa: Cloud Run lo inyecta automáticamente (reserved env name).
$envVars = "NODE_ENV=production,FIREBASE_PROJECT_ID=veamos-tv,JWT_EXPIRES_IN=7d,JWT_REFRESH_EXPIRES_IN=30d,SCRAPE_INTERVAL_MINUTES=30,LOG_TIMEZONE=America/Bogota"
if ($PublicBaseUrl) {
  $envVars += ",PUBLIC_BASE_URL=$PublicBaseUrl"
}

Write-Host "=== Deployando $Service a Cloud Run ($Region) ==="

gcloud run deploy $Service `
  --source . `
  --region $Region `
  --platform managed `
  --allow-unauthenticated `
  --memory $Memory `
  --cpu $Cpu `
  --concurrency $Concurrency `
  --min-instances $MinInstances `
  --max-instances $MaxInstances `
  --timeout $TimeoutSec `
  --no-cpu-throttling `
  --set-env-vars $envVars `
  --set-secrets "JWT_SECRET=JWT_SECRET:latest,FALLBACK_EXTRACT_KEY=FALLBACK_EXTRACT_KEY:latest"

Write-Host ""
$svcUrl = gcloud run services describe $Service --region $Region --format="value(status.url)"
Write-Host "=== URL del servicio: $svcUrl ==="

if (-not $PublicBaseUrl) {
  Write-Host ""
  Write-Host "!!! IMPORTANTE !!!"
  Write-Host "Vuelve a desplegar con PUBLIC_BASE_URL = la URL del servicio (para que el"
  Write-Host "proxy de los streams extraidos aqui apunte a Cloud Run):"
  Write-Host "  .\deploy-cloudrun.ps1 -PublicBaseUrl `"$svcUrl`""
  Write-Host "Luego en apphosting.yaml pon FALLBACK_EXTRACT_URL = $svcUrl"
}

Write-Host ""
Write-Host "Permiso Firestore para la cuenta de servicio de Cloud Run:"
Write-Host "  gcloud projects add-iam-policy-binding veamos-tv --member=serviceAccount:<NUM_PROYECTO>-compute@developer.gserviceaccount.com --role=roles/datastore.user"
