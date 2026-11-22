import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const developerId = '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';

export async function assertMacSigningReady(run = exec) {
  const { stdout } = await run('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!/"Developer ID Application: /m.test(stdout)) {
    throw new Error('Install a valid Developer ID Application certificate and its private key.');
  }
}

export async function verifyMacDmgSignature(path, run = exec) {
  await run('codesign', ['--verify', '--strict', '-R', developerId, path]);
}

export async function verifyNotarizedMacDmg(path, run = exec) {
  await verifyMacDmgSignature(path, run);
  await run('xcrun', ['stapler', 'validate', path]);
}

export async function notarizeMacDmg(path, profile, run = exec) {
  await verifyMacDmgSignature(path, run);
  const { stdout } = await run('xcrun', [
    'notarytool', 'submit', path, '--keychain-profile', profile, '--wait', '--output-format', 'json',
    '--timeout', '30m',
  ]);
  const { status, id } = JSON.parse(stdout);
  if (status !== 'Accepted') throw new Error(`Apple notarization: ${status} (submission ${id})`);
  await run('xcrun', ['stapler', 'staple', path]);
  await verifyNotarizedMacDmg(path, run);
  return id;
}
