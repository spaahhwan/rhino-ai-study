<#
  git_sync.ps1 - commit the Obsidian wiki and push it to GitHub.

  Usage: powershell -NoProfile -ExecutionPolicy Bypass -File git_sync.ps1 [-RepoRoot <dir>] [-Message <text>]

  Exit codes (read by rhino_cmd_history_dump.py):
    0 = pushed, or nothing to push
    2 = git is not installed, or the wiki folder is not a git repository
    3 = committed locally, but no GitHub remote is configured yet
    4 = pull or push failed (sign-in, network, conflict)
    5 = commit failed (for example git user.name / user.email not set)

  Messages are ASCII on purpose: Windows PowerShell 5.1 misreads non-ASCII
  text in script files saved without a BOM.
#>
param(
    [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$Message = ("Auto-sync: command log " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
)

# English git messages, and never wait for a terminal password prompt.
$env:LC_ALL = 'C'
$env:GIT_TERMINAL_PROMPT = '0'

function Write-Tail($lines) {
    # PowerShell 5.1 turns blank stderr lines into "System.Management.Automation.RemoteException"; drop them.
    $lines | ForEach-Object { "$_".Trim() } |
        Where-Object { $_ -ne '' -and $_ -ne 'System.Management.Automation.RemoteException' } |
        Select-Object -Last 5 | ForEach-Object { Write-Output "  $_" }
}

# Find git, even when the caller (e.g. Rhino) started before git was added to PATH.
$git = $null
$cmd = Get-Command git -ErrorAction SilentlyContinue
if ($cmd) { $git = $cmd.Source }
elseif (Test-Path 'C:\Program Files\Git\cmd\git.exe') { $git = 'C:\Program Files\Git\cmd\git.exe' }
if (-not $git) { Write-Output '[git_sync] git is not installed.'; exit 2 }

if (-not (Test-Path -LiteralPath $RepoRoot)) { Write-Output "[git_sync] Folder not found: $RepoRoot"; exit 2 }
Set-Location -LiteralPath $RepoRoot

# Must be the top of its own repository, so we never commit into some parent repo.
$top = & $git rev-parse --show-toplevel 2>$null
if ($LASTEXITCODE -ne 0 -or -not $top) { Write-Output "[git_sync] $RepoRoot is not a git repository. Run: git init -b main `"$RepoRoot`""; exit 2 }
if ((Resolve-Path -LiteralPath $top).Path.TrimEnd('\') -ne (Resolve-Path -LiteralPath $RepoRoot).Path.TrimEnd('\')) {
    Write-Output "[git_sync] $RepoRoot is inside another repository ($top); refusing to commit there."
    exit 2
}

$name = & $git config user.name
$email = & $git config user.email
if (-not $name -or -not $email) {
    Write-Output '[git_sync] git user.name / user.email are not set, so nothing was committed.'
    Write-Output '  Set them once with: git config --global user.name "<name>"  and  git config --global user.email "<email>"'
    exit 5
}

# safecrlf=false: skip the "LF will be replaced by CRLF" warnings Git for Windows prints for every new note.
& $git -c core.safecrlf=false add -A
& $git diff --cached --quiet
$changed = ($LASTEXITCODE -ne 0)
if ($changed) {
    $out = & $git commit -q -m $Message 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Output '[git_sync] Commit failed:'; Write-Tail $out; exit 5 }
}

$remotes = & $git remote
if (-not $remotes) {
    if ($changed) { Write-Output '[git_sync] Committed locally. No GitHub remote is set, so nothing was pushed.' }
    else { Write-Output '[git_sync] Nothing new to commit. No GitHub remote is set.' }
    exit 3
}

& $git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    $out = & $git pull -q --rebase --autostash 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Output '[git_sync] Pull from GitHub failed:'; Write-Tail $out; exit 4 }
    $out = & $git push -q 2>&1
} else {
    $out = & $git push -q -u origin HEAD 2>&1
}
if ($LASTEXITCODE -ne 0) { Write-Output '[git_sync] Push to GitHub failed:'; Write-Tail $out; exit 4 }

if ($changed) { Write-Output '[git_sync] Committed and pushed to GitHub.' }
else { Write-Output '[git_sync] Nothing new to commit; GitHub is up to date.' }
exit 0
