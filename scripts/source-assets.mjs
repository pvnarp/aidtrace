import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Reviewed immutable exception, not a general font or binary permission.
export const interAsset = Object.freeze({
  path: 'src/app/fonts/InterVariable.woff2',
  bytes: 352240,
  sha256: '693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3',
  license: 'src/app/fonts/OFL.txt',
  licenseSha256: '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a',
  revision: 'e3a3d4c57d5ecc01453a575621882a384c1995a3',
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function assertSourceAsset(path, bytes, root) {
  if (path === interAsset.path) {
    assert.equal(bytes.length, interAsset.bytes, 'Unreviewed font size');
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'wOF2', 'Invalid font signature');
    assert.equal(sha(bytes), interAsset.sha256, 'Unreviewed font bytes');
    const license = resolve(root, interAsset.license);
    assert(lstatSync(license).isFile() && !lstatSync(license).isSymbolicLink(), 'Regular font license required');
    assert(realpathSync(license).startsWith(realpathSync(root) + '/'), 'Font license path escape');
    assert.equal(sha(readFileSync(license)), interAsset.licenseSha256, 'Exact font license required');
    return 'reviewed-font';
  }
  assert(!/\.(?:woff2?|ttf|otf|eot)$/i.test(path), 'Unreviewed font path');
  assert(!bytes.includes(0), 'Binary source asset');
  assert(Buffer.from(bytes.toString('utf8')).equals(bytes), 'Non UTF-8 source asset');
  return 'text';
}
