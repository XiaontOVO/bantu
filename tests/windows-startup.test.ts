import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test('Windows launcher fingerprints compiled files and requires verified ownership before restart', {
  skip: process.platform !== 'win32',
}, async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'bantu-startup-test-'));
  try {
    const helperPath = join(process.cwd(), 'scripts', 'bantu-process.ps1');
    const script = `
$ErrorActionPreference = 'Stop'
. ${psLiteral(helperPath)}
$root = ${psLiteral(temporaryRoot)}
$sourceRoot = Join-Path $root 'dist\\src'
New-Item -ItemType Directory -Force -Path $sourceRoot | Out-Null
$sourceFile = Join-Path $sourceRoot 'main.js'
Set-Content -LiteralPath $sourceFile -Value 'module one' -NoNewline
$firstFingerprint = Get-BantuBuildFingerprint -Root $root
$sameFingerprint = Get-BantuBuildFingerprint -Root $root
if ($firstFingerprint -ne $sameFingerprint) { throw 'fingerprint changed without a build change' }

$recordPath = Join-Path $root 'server.pid'
Write-BantuProcessRecord -Path $recordPath -ProcessId 1234 -Port 8787 -Root $root -BuildFingerprint $firstFingerprint
$record = Read-BantuProcessRecord -Path $recordPath
if ($record.BuildFingerprint -ne $firstFingerprint) { throw 'PID record did not retain the fingerprint' }
if ((Get-BantuBuildRecordAction -Record $record -Identity 'current' -Root $root -BuildFingerprint $firstFingerprint) -ne 'current') { throw 'matching build was not reusable' }

Set-Content -LiteralPath $sourceFile -Value 'module two' -NoNewline
$newFingerprint = Get-BantuBuildFingerprint -Root $root
if ($newFingerprint -eq $firstFingerprint) { throw 'changed compiled file did not change the fingerprint' }
if ((Get-BantuBuildRecordAction -Record $record -Identity 'current' -Root $root -BuildFingerprint $newFingerprint) -ne 'stale') { throw 'changed build was not marked stale' }
if ((Get-BantuBuildRecordAction -Record $record -Identity 'current' -Root (Join-Path $root 'other') -BuildFingerprint $newFingerprint) -ne 'unverified') { throw 'mismatched root was treated as owned' }
if ((Get-BantuBuildRecordAction -Record $record -Identity 'legacy' -Root $root -BuildFingerprint $newFingerprint) -ne 'unverified') { throw 'ambiguous command identity was treated as owned' }
`;
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedScript,
    ], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
