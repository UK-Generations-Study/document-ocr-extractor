<#
.SYNOPSIS
    Build the two air-gapped images and save them as one transferable tarball.

.DESCRIPTION
    Run this on a NETWORKED machine: the build downloads ~1.64 GB of OCR model
    weights from HuggingFace, the Presidio analyzer's clinical model, and CPU
    torch. Nothing is downloaded again at runtime - both images are fully
    self-contained, which is the whole point.

    Copy the resulting tarball and compose.yaml to the air-gapped host:

        docker load -i airgap-bundle.tar
        docker compose up -d
        # then open http://localhost:7777

.PARAMETER OutFile
    Where to write the bundle. Defaults to airgap-bundle.tar in the repo root.

.PARAMETER QuickReadOnly
    Omit the Deep Read VLM weights (~1.37 GB), leaving Quick Read only. Much
    smaller to carry across the gap.

.PARAMETER Platform
    Target architecture. linux/amd64 covers both Linux x86_64 hosts and
    Windows Docker Desktop.

.NOTES
    Windows blocks local scripts by default, so invoke it like this rather
    than as .\scripts\build-airgap.ps1 - the bypass applies to that one
    process and changes nothing on the machine:

        powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-airgap.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-airgap.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-airgap.ps1 -QuickReadOnly -OutFile D:\transfer\doe.tar
#>
[CmdletBinding()]
param(
    [string] $OutFile = (Join-Path $PSScriptRoot '..\airgap-bundle.tar'),
    [switch] $QuickReadOnly,
    [string] $Platform = 'linux/amd64'
)

$ErrorActionPreference = 'Stop'

$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$appImage = 'document-ocr-extractor:latest'
$analyzerImage = 'document-ocr-extractor-presidio:latest'

# The Dockerfile takes the Deep Read toggle as a build arg: '--deep' fetches
# the VLM weights, empty omits them.
$fetchDeep = if ($QuickReadOnly) { '' } else { '--deep' }

Write-Host "Building $appImage ($(if ($QuickReadOnly) { 'Quick Read only' } else { 'with Deep Read' }))..." -ForegroundColor Cyan
docker build --platform $Platform --build-arg "FETCH_DEEP=$fetchDeep" -t $appImage $repo
if ($LASTEXITCODE -ne 0) { throw "Build of $appImage failed." }

Write-Host "Building $analyzerImage..." -ForegroundColor Cyan
docker build --platform $Platform -t $analyzerImage (Join-Path $repo 'docker\presidio')
if ($LASTEXITCODE -ne 0) { throw "Build of $analyzerImage failed." }

# Saved uncompressed: the bulk of both images is model weights, which are
# already compressed, so gzip buys very little for the time it costs.
Write-Host "Saving both images to $OutFile..." -ForegroundColor Cyan
docker save -o $OutFile $appImage $analyzerImage
if ($LASTEXITCODE -ne 0) { throw 'docker save failed.' }

$sizeGb = [math]::Round((Get-Item $OutFile).Length / 1GB, 2)
Write-Host ""
Write-Host "Done. $OutFile ($sizeGb GB)" -ForegroundColor Green
Write-Host "Copy it and compose.yaml to the air-gapped host, then:" -ForegroundColor Green
Write-Host "  docker load -i $(Split-Path $OutFile -Leaf)"
Write-Host "  docker compose up -d"
Write-Host "  # open http://localhost:7777"
