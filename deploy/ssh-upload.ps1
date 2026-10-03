$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
$Ip = '192.168.45.145'
$User = 'wodudd102'
$sec = ConvertTo-SecureString 'akdntm130' -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($User, $sec)

$local = 'C:\Users\adwin2025\jc-app.tar.gz'
if (-not (Test-Path $local)) { throw "파일 없음: $local" }
$size = (Get-Item $local).Length
Write-Output ("UPLOADING: $size bytes")

# SCP 업로드 (홈 디렉터리로)
Set-SCPItem -ComputerName $Ip -Credential $cred -AcceptKey -Force -Path $local -Destination '/home/wodudd102'

# 업로드 검증
$session = New-SSHSession -ComputerName $Ip -Credential $cred -AcceptKey -Force -ConnectionTimeout 15
try {
  $r = Invoke-SSHCommand -SessionId $session.SessionId -Command 'ls -la ~/jeolim-cabbage-ubuntu.zip && md5sum ~/jeolim-cabbage-ubuntu.zip' -TimeOut 30
  Write-Output $r.Output
} finally {
  Remove-SSHSession -SessionId $session.SessionId | Out-Null
}
Write-Output 'UPLOAD-DONE'
