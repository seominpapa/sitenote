import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyNotarizedMacDmg } from '../desktop/mac-signing.mjs';

const releaseFiles = [
  'Sitenote-Desktop.zip',
  'Sitenote-macOS-arm64.dmg',
  'Sitenote-macOS-x64.dmg',
  'Sitenote-Windows-x64.exe',
  'THIRD-PARTY-NOTICES.txt',
];

export async function stageRelease(source, verifyMac = verifyNotarizedMacDmg) {
  for (const name of releaseFiles) {
    const file = await lstat(join(source, name)).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (!file?.isFile() || !file.size) throw Error(`배포 파일이 없거나 비어 있습니다: ${name}`);
  }

  const output = await mkdtemp(join(source, 'desktop-release-'));
  try {
    const sums = [];
    for (const name of releaseFiles) {
      const path = join(output, name);
      await copyFile(join(source, name), path);
      if (name.endsWith('.dmg')) await verifyMac(path);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      sums.push(`${hash.digest('hex')}  ${name}\n`);
    }
    await writeFile(join(output, 'SHA256SUMS.txt'), sums.join(''));
    return output;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length > 3) throw Error('사용법: node scripts/stage-release.mjs [배포 파일 폴더]');
    if (process.platform !== 'darwin') throw Error('DMG의 서명과 공증을 검증할 수 있는 Mac에서 실행하세요.');
    console.log(await stageRelease(resolve(process.argv[2] ?? 'dist')));
  } catch (error) {
    console.error(`Sitenote: ${error.message}`);
    process.exitCode = 1;
  }
}
