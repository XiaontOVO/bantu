param(
  [string]$SdkRoot = '',
  [string]$JavaRoot = '',
  [string]$OutputPath = '',
  [switch]$Install,
  [string]$Device = ''
)
$ErrorActionPreference = 'Stop'
$bantuProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$SdkRoot) { $SdkRoot = Join-Path $bantuProject 'data/android-sdk' }
if (!$JavaRoot) { $JavaRoot = $env:JAVA_HOME }
if (!$JavaRoot) {
  $bantuJava = Get-Command java -ErrorAction Stop
  $JavaRoot = Split-Path (Split-Path $bantuJava.Source -Parent) -Parent
}
$bantuSdk = [IO.Path]::GetFullPath($SdkRoot)
$bantuJavaBin = Join-Path $JavaRoot 'bin'
$bantuTools = Join-Path $bantuSdk 'build-tools/35.0.0'
$bantuPlatform = Join-Path $bantuSdk 'platforms/android-35/android.jar'
foreach ($bantuTool in @($bantuPlatform, (Join-Path $bantuTools 'aapt2.exe'), (Join-Path $bantuTools 'lib/d8.jar'), (Join-Path $bantuTools 'lib/apksigner.jar'), (Join-Path $bantuTools 'zipalign.exe'), (Join-Path $bantuJavaBin 'javac.exe'))) {
  if (!(Test-Path -LiteralPath $bantuTool)) { throw "Missing Android build dependency: $bantuTool. Install SDK Platform 35, Build-Tools 35.0.0 and JDK 17+; pass -SdkRoot and -JavaRoot when necessary." }
}
function Invoke-BantuTool([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Android build failed ($LASTEXITCODE): $File" }
}
$bantuBuild = Join-Path $bantuProject ('tmp/android-build/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
$bantuGenerated = Join-Path $bantuBuild 'generated'
$bantuClasses = Join-Path $bantuBuild 'classes'
$bantuDex = Join-Path $bantuBuild 'dex'
$bantuRes = Join-Path $bantuBuild 'res'
New-Item -ItemType Directory -Path $bantuGenerated,$bantuClasses,$bantuDex,$bantuRes -Force | Out-Null
$bantuApp = Join-Path $bantuProject 'android/app/src'
Copy-Item -Path (Join-Path $bantuApp 'main/res/*') -Destination $bantuRes -Recurse -Force
if (Test-Path -LiteralPath (Join-Path $bantuApp 'debug/res')) {
  Get-ChildItem -LiteralPath (Join-Path $bantuApp 'debug/res') -Recurse -File | ForEach-Object {
    $bantuRelative = $_.FullName.Substring((Join-Path $bantuApp 'debug/res').Length).TrimStart('\','/')
    $bantuDestination = Join-Path $bantuRes $bantuRelative
    New-Item -ItemType Directory -Path (Split-Path $bantuDestination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $bantuDestination -Force
  }
}
[xml]$bantuManifest = Get-Content -LiteralPath (Join-Path $bantuApp 'main/AndroidManifest.xml') -Raw -Encoding UTF8
$bantuAndroidNs = 'http://schemas.android.com/apk/res/android'
$bantuManifest.manifest.application.SetAttribute('debuggable', $bantuAndroidNs, 'true') | Out-Null
$bantuManifest.manifest.SetAttribute('package','cn.bantu.travel') | Out-Null
$bantuManifest.manifest.SetAttribute('versionCode',$bantuAndroidNs,'1') | Out-Null
$bantuManifest.manifest.SetAttribute('versionName',$bantuAndroidNs,'0.1.0-test') | Out-Null
$bantuUsesSdk = $bantuManifest.manifest.'uses-sdk'
if (!$bantuUsesSdk) { $bantuUsesSdk = $bantuManifest.CreateElement('uses-sdk'); $bantuManifest.manifest.PrependChild($bantuUsesSdk) | Out-Null }
$bantuUsesSdk.SetAttribute('minSdkVersion',$bantuAndroidNs,'26') | Out-Null
$bantuUsesSdk.SetAttribute('targetSdkVersion',$bantuAndroidNs,'35') | Out-Null
$bantuManifestPath = Join-Path $bantuBuild 'AndroidManifest.xml'
$bantuManifest.Save($bantuManifestPath)
$bantuApk = Join-Path $bantuBuild 'resources.ap_'
$bantuCompiledResources = Join-Path $bantuBuild 'resources.zip'
Invoke-BantuTool (Join-Path $bantuTools 'aapt2.exe') @('compile','--dir',$bantuRes,'-o',$bantuCompiledResources)
$bantuAaptArgs = @('link','--auto-add-overlay','--java',$bantuGenerated,'--manifest',$bantuManifestPath,'-I',$bantuPlatform,'-o',$bantuApk,$bantuCompiledResources)
if (Test-Path -LiteralPath (Join-Path $bantuApp 'main/assets')) { $bantuAaptArgs += @('-A',(Join-Path $bantuApp 'main/assets')) }
Invoke-BantuTool (Join-Path $bantuTools 'aapt2.exe') $bantuAaptArgs
$bantuPackageDir = Join-Path $bantuGenerated 'cn/bantu/travel'
New-Item -ItemType Directory -Path $bantuPackageDir -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $bantuPackageDir 'BuildConfig.java'), 'package cn.bantu.travel; public final class BuildConfig { public static final boolean DEBUG=true; public static final String VERSION_NAME="0.1.0-test"; public static final int VERSION_CODE=1; }', [Text.UTF8Encoding]::new($false))
$bantuSources = @((Get-ChildItem -LiteralPath (Join-Path $bantuApp 'main/java'),$bantuGenerated -Recurse -Filter '*.java').FullName)
$bantuArgFile = Join-Path $bantuBuild 'sources.txt'
[IO.File]::WriteAllLines($bantuArgFile, @($bantuSources | ForEach-Object { '"' + $_.Replace('\','/') + '"' }), [Text.UTF8Encoding]::new($false))
Invoke-BantuTool (Join-Path $bantuJavaBin 'javac.exe') @('-encoding','UTF-8','--release','8','-classpath',$bantuPlatform,'-d',$bantuClasses,('@' + $bantuArgFile))
$bantuJar = Join-Path $bantuBuild 'classes.jar'
Invoke-BantuTool (Join-Path $bantuJavaBin 'jar.exe') @('cf',$bantuJar,'-C',$bantuClasses,'.')
Invoke-BantuTool (Join-Path $bantuJavaBin 'java.exe') @('-cp',(Join-Path $bantuTools 'lib/d8.jar'),'com.android.tools.r8.D8','--lib',$bantuPlatform,'--min-api','26','--output',$bantuDex,$bantuJar)
Invoke-BantuTool (Join-Path $bantuJavaBin 'jar.exe') @('uf',$bantuApk,'-C',$bantuDex,'classes.dex')
$bantuAligned = Join-Path $bantuBuild 'bantu-aligned.apk'
Invoke-BantuTool (Join-Path $bantuTools 'zipalign.exe') @('-f','-p','4',$bantuApk,$bantuAligned)
$bantuKeyDir = Join-Path $bantuProject 'data/android-signing'
New-Item -ItemType Directory -Path $bantuKeyDir -Force | Out-Null
$bantuKeystore = Join-Path $bantuKeyDir 'bantu-debug.jks'
if (!(Test-Path -LiteralPath $bantuKeystore)) {
  Invoke-BantuTool (Join-Path $bantuJavaBin 'keytool.exe') @('-genkeypair','-keystore',$bantuKeystore,'-storepass','android','-keypass','android','-alias','androiddebugkey','-keyalg','RSA','-keysize','2048','-validity','10000','-dname','CN=Android Debug,O=Android,C=US')
}
if (!$OutputPath) { $OutputPath = Join-Path $bantuProject ('submission/' + [char]0x4F34 + [char]0x9014 + '-Android' + [char]0x6D4B + [char]0x8BD5 + [char]0x7248 + '.apk') }
$bantuOutput = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Path (Split-Path $bantuOutput -Parent) -Force | Out-Null
$bantuSigned = Join-Path $bantuBuild 'bantu-debug.apk'
Invoke-BantuTool (Join-Path $bantuJavaBin 'java.exe') @('-jar',(Join-Path $bantuTools 'lib/apksigner.jar'),'sign','--ks',$bantuKeystore,'--ks-pass','pass:android','--key-pass','pass:android','--out',$bantuSigned,$bantuAligned)
Invoke-BantuTool (Join-Path $bantuJavaBin 'java.exe') @('-jar',(Join-Path $bantuTools 'lib/apksigner.jar'),'verify','--verbose',$bantuSigned)
Copy-Item -LiteralPath $bantuSigned -Destination $bantuOutput -Force
$bantuHash = (Get-FileHash -LiteralPath $bantuOutput -Algorithm SHA256).Hash.ToLowerInvariant()
$bantuInputs = @(Get-ChildItem -LiteralPath (Join-Path $bantuApp 'main'),(Join-Path $bantuApp 'debug') -File -Recurse | Sort-Object FullName | ForEach-Object {
  @{path=$_.FullName.Substring($bantuProject.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
@{artifact=$bantuOutput;sha256=$bantuHash;package='cn.bantu.travel';minSdk=26;targetSdk=35;debug=$true;builtAt=[DateTime]::UtcNow.ToString('o');buildDirectory=$bantuBuild;sourceFiles=$bantuInputs;buildScriptSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();loadsSharedFrontend=$true;bundlesBackend=$false} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $bantuBuild 'build-proof.json') -Encoding UTF8
Write-Output "Android test APK: $bantuOutput"
Write-Output "SHA256: $bantuHash"
if ($Install) {
  $bantuAdbArgs = @()
  if ($Device) { $bantuAdbArgs += @('-s',$Device) }
  $bantuAdbArgs += @('install','-r',$bantuSigned)
  Invoke-BantuTool (Join-Path $bantuSdk 'platform-tools/adb.exe') $bantuAdbArgs
}
