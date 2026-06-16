param(
  [Parameter(Mandatory = $true)] [string]$ApiAppId,
  [Parameter(Mandatory = $true)] [ValidateSet("Admin", "Operaciones", "Revision", "SoloLectura")] [string]$RoleValue,
  [Parameter(Mandatory = $true)] [string[]]$Emails
)

$ErrorActionPreference = "Stop"

Write-Host "[1/4] Obteniendo service principal del API..."
$apiSpId = az ad sp list --filter "appId eq '$ApiAppId'" --query "[0].id" -o tsv
if (-not $apiSpId) {
  throw "No existe service principal para ApiAppId=$ApiAppId. Ejecuta setup-entra-auth.ps1 primero."
}

Write-Host "[2/4] Resolviendo appRoleId para rol '$RoleValue'..."
$roleId = az ad sp show --id $apiSpId --query "appRoles[?value=='$RoleValue' && isEnabled==\`true\`].id | [0]" -o tsv
if (-not $roleId) {
  throw "No se encontro app role '$RoleValue' en el API."
}

Write-Host "[3/4] Asignando rol por correo..."
foreach ($email in $Emails) {
  $trimmed = $email.Trim()
  if (-not $trimmed) { continue }

  $userId = az ad user show --id $trimmed --query "id" -o tsv 2>$null
  if (-not $userId) {
    Write-Warning "No se encontro usuario: $trimmed"
    continue
  }

  # Evita duplicados.
  $already = az rest --method GET --url "https://graph.microsoft.com/v1.0/users/$userId/appRoleAssignments" --query "value[?resourceId=='$apiSpId' && appRoleId=='$roleId'] | length(@)" -o tsv
  if ($already -and [int]$already -gt 0) {
    Write-Host "Ya asignado: $trimmed -> $RoleValue"
    continue
  }

  $body = @{ principalId = $userId; resourceId = $apiSpId; appRoleId = $roleId } | ConvertTo-Json -Compress
  az rest --method POST --url "https://graph.microsoft.com/v1.0/users/$userId/appRoleAssignments" --headers "Content-Type=application/json" --body $body | Out-Null
  Write-Host "Asignado: $trimmed -> $RoleValue"
}

Write-Host "[4/4] Listo"
Write-Host "Si falla por permisos, da admin consent a Graph: AppRoleAssignment.ReadWrite.All + Application.Read.All + User.Read.All."
