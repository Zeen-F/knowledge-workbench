param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'

function Read-GitHubJson([string]$Endpoint) {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $result = & gh api $Endpoint
    if ($LASTEXITCODE -eq 0) { return $result | ConvertFrom-Json }
    if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
  }
  throw "GitHub request failed: $Endpoint"
}

$repo = $env:GITHUB_REPOSITORY
$runId = $env:PACKAGE_RUN
$tag = $env:RELEASE_TAG
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Invalid repository' }
if ($runId -notmatch '^\d+$') { throw 'Invalid package run ID' }
if ($tag -notmatch '^v\d+\.\d+\.\d+-alpha\.\d+$') { throw 'Invalid preview tag' }
$version = $tag.Substring(1)
$run = Read-GitHubJson "repos/$repo/actions/runs/$runId"
if ($run.name -ne 'Windows preview package' -or $run.event -ne 'workflow_dispatch' -or $run.status -ne 'completed' -or $run.conclusion -ne 'success') {
  throw 'The selected run is not a successful completed package run'
}
$releases = @(Read-GitHubJson "repos/$repo/releases?per_page=100")
$matching = @($releases | Where-Object { $_.tag_name -eq $tag })
if ($matching.Count -ne 1) { throw 'Expected one matching draft release' }
$release = $matching[0]
$releaseEndpoint = "repos/$repo/releases/$($release.id)"
if (-not $release.draft -or -not $release.prerelease -or $release.target_commitish -ne $run.head_sha) {
  throw 'The draft preview does not target the tested package commit'
}
$artifacts = Read-GitHubJson "repos/$repo/actions/runs/$runId/artifacts"
$artifact = @($artifacts.artifacts | Where-Object { $_.name -eq 'windows-x64-preview' -and -not $_.expired })
if ($artifact.Count -ne 1 -or $artifact[0].digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Expected one valid package artifact' }
if ($ValidateOnly) { Write-Output "Validated package run $runId and draft $tag"; exit 0 }

$root = Join-Path $PSScriptRoot '../../.local/release-upload'
$assetsDirectory = Join-Path $root 'release'
$installer = Join-Path $assetsDirectory "KnowledgeWorkbench-$version-win-x64.exe"
$blockmap = "$installer.blockmap"
foreach ($file in @($installer, $blockmap)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw 'Missing package asset' }
}
$qa = Get-Content (Join-Path $root 'output/playwright/packaged-paperdesk/result.json') -Raw | ConvertFrom-Json
if (-not $qa.passed -or -not $qa.cleanup -or $qa.versions.workbench.version -ne $version) { throw 'Package acceptance result is missing or mismatched' }
$pluginAssets = @($release.assets | Where-Object { $_.name -match '^knowledge-workbench-codex-plugin-\d+\.\d+\.\d+-alpha\.\d+\.zip$' -and $_.state -eq 'uploaded' })
if ($pluginAssets.Count -ne 1 -or $pluginAssets[0].digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Expected one uploaded plugin ZIP with a digest' }
$plugin = $pluginAssets[0]
& gh release download $tag --repo $repo --pattern $plugin.name --dir $assetsDirectory
if ($LASTEXITCODE -ne 0) { throw 'Plugin download failed' }
$pluginPath = Join-Path $assetsDirectory $plugin.name
if ('sha256:' + (Get-FileHash $pluginPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plugin.digest) { throw 'Plugin checksum mismatch' }
$pluginVersion = $plugin.name -replace '^knowledge-workbench-codex-plugin-(.*)\.zip$', '$1'
$commit = Read-GitHubJson "repos/$repo/git/commits/$($run.head_sha)"
$buildInfo = [ordered]@{
  desktopVersion = $version
  pluginVersion = $pluginVersion
  sourceCommit = $run.head_sha
  sourceTree = $commit.tree.sha
  packageRun = $run.html_url
  artifactId = $artifact[0].id
  artifactDigest = $artifact[0].digest
  packagedAcceptance = @{ passed = $qa.passed; cleanup = $qa.cleanup; checks = $qa.checks }
  assets = @(@($installer, $blockmap, $pluginPath) | ForEach-Object {
    @{ name = (Split-Path $_ -Leaf); size = (Get-Item $_).Length; sha256 = (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant() }
  })
}
$infoPath = Join-Path $assetsDirectory 'BUILDINFO.json'
$sumPath = Join-Path $assetsDirectory 'SHA256SUMS.txt'
$buildInfo | ConvertTo-Json -Depth 8 | Set-Content $infoPath -Encoding utf8NoBOM
@($installer, $blockmap, $pluginPath, $infoPath) | ForEach-Object {
  (Get-FileHash $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path $_ -Leaf)
} | Set-Content $sumPath -Encoding utf8NoBOM

# Recheck draft state immediately before uploading. Existing equal assets allow a safe retry.
$release = Read-GitHubJson $releaseEndpoint
if (-not $release.draft -or $release.target_commitish -ne $run.head_sha) { throw 'Draft changed before upload' }
foreach ($file in @($installer, $blockmap, $infoPath, $sumPath)) {
  $name = Split-Path $file -Leaf
  $digest = 'sha256:' + (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
  $existing = @($release.assets | Where-Object { $_.name -eq $name })
  if ($existing.Count -gt 0) {
    if ($existing.Count -ne 1 -or $existing[0].state -ne 'uploaded' -or $existing[0].digest -ne $digest) { throw "Existing asset differs: $name" }
    continue
  }
  & gh release upload $tag $file --repo $repo
  if ($LASTEXITCODE -ne 0) { throw "Asset upload failed: $name" }
}
$release = Read-GitHubJson $releaseEndpoint
foreach ($file in @($installer, $blockmap, $pluginPath, $infoPath, $sumPath)) {
  $name = Split-Path $file -Leaf
  $expected = 'sha256:' + (Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant()
  $remote = @($release.assets | Where-Object { $_.name -eq $name })
  if ($remote.Count -ne 1 -or $remote[0].state -ne 'uploaded' -or $remote[0].digest -ne $expected) { throw "Remote asset verification failed: $name" }
}
Write-Output "All draft assets verified for $tag; publication remains a separate step."
