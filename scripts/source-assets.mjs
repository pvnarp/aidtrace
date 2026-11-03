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
// IAC-384: the ten invented receipt photos of the owner-only photo evaluation (ai/eval-photo-v1.json, scripts/photo-eval-fixtures.mjs). A reviewed immutable exception like the font above,
// not a general image permission: only these paths, only these exact bytes (length and SHA-256, which are also the sha256 values in ai/eval-photo-v1.json) and only with the PNG signature.
// The judge export does not ship them; the private source package does.
export const photoFixtureAssets = Object.freeze(Object.fromEntries([
  ['blurred', 28625, '6774289bb25c8580250a43d51ed73760205b09c1b954782c8bc12d0198bc3a61'],
  ['crumpled', 58429, 'f2d40841d5c34486bd8f6b6a620be2599018af7e5a54a435a30bf0d5090ff1a0'],
  ['handwritten-tip', 23695, '6aa52014ffa35d03a34f451a2294b61ac933c681bb95adc9cfeec296f9890269'],
  ['inject-add-line', 21543, '7e5b5167d0f4d19ada543ba12fd89a67362c0afb5759517ef9db5210f71fe14f'],
  ['inject-approved-stamp', 32079, 'e4a63c71c158debe3bbea539ef588d4102c3db73ea48d6e6dc212a042573bd71'],
  ['inject-ignore-rules', 20420, 'e2592a7855c5193450bc9e20fc596a1d1fbc2d500ee5996f3916d866e4e33d5e'],
  ['inject-reveal', 23735, '025313c262f6f5f6673d531e275bd39ecf4aecc6224fcc6a30d0c4d2d2221d99'],
  ['inject-system-notice', 20395, '0b97736132c7d5846ee3ebc72db725a4292fdf4a2126a05a2448496d59b6ae7d'],
  ['rotated', 29031, '69c41fcb82c71704df8c9c073813d4b2539a5cc4bdf03e7d66eabc72c9b2c469'],
  ['spanish', 15579, '95c81acea631765b9a114be0970713113c0ea8423713cd91ef427a5b1aa7601c'],
].map(([name, bytes, sha256]) => [`ai/photo-eval-fixtures/${name}.png`, Object.freeze({ path: `ai/photo-eval-fixtures/${name}.png`, bytes, sha256 })])));
export const isReviewedPhotoFixturePath = path => Object.hasOwn(photoFixtureAssets, path);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
  if (isReviewedPhotoFixturePath(path)) {
    const entry = photoFixtureAssets[path];
    assert.equal(bytes.length, entry.bytes, 'Unreviewed photo fixture size');
    assert(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'Invalid photo fixture signature');
    assert.equal(sha(bytes), entry.sha256, 'Unreviewed photo fixture bytes');
    return 'reviewed-photo-fixture';
  }
  assert(!/\.(?:woff2?|ttf|otf|eot)$/i.test(path), 'Unreviewed font path');
  assert(!bytes.includes(0), 'Binary source asset');
  assert(Buffer.from(bytes.toString('utf8')).equals(bytes), 'Non UTF-8 source asset');
  return 'text';
}
