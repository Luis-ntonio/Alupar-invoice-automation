param(
  [Parameter(Mandatory = $true)] [string[]]$Emails,
  [string]$RedirectUrl = "https://proyecto2-facturas.kindmoss-eea411cc.eastus2.azurecontainerapps.io/login.html",
  [switch]$SendInvitationMessage = $true
)

$ErrorActionPreference = "Stop"

foreach ($email in $Emails) {
  $email = $email.Trim()
  if (-not $email) { continue }

  Write-Host "Invitando: $email"
  $body = @{
    invitedUserEmailAddress = $email
    inviteRedirectUrl       = $RedirectUrl
    sendInvitationMessage   = [bool]$SendInvitationMessage
  } | ConvertTo-Json -Compress

  $bodyPath = Join-Path $env:TEMP "invite-body.json"
  $body | Set-Content -Path $bodyPath -Encoding utf8

  az rest --method POST --url "https://graph.microsoft.com/v1.0/invitations" --body "@$bodyPath" --headers "Content-Type=application/json" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  FALLO: $email"
  } else {
    Write-Host "  OK: $email"
  }
}
