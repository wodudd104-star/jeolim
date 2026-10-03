param(
  [string]$Ip = '192.168.45.145',
  [string]$User = 'wodudd102',
  [string]$Pass = 'akdntm130',
  [string]$Command = 'whoami && hostname && uname -m && cat /etc/os-release | head -2',
  [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
Import-Module Posh-SSH
$sec = ConvertTo-SecureString $Pass -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential($User, $sec)
$session = New-SSHSession -ComputerName $Ip -Credential $cred -AcceptKey -Force -ConnectionTimeout 15
try {
  $result = Invoke-SSHCommand -SessionId $session.SessionId -Command $Command -TimeOut $TimeoutSec
  Write-Output ('EXIT:' + $result.ExitStatus)
  Write-Output $result.Output
} finally {
  if ($session) { Remove-SSHSession -SessionId $session.SessionId | Out-Null }
}
