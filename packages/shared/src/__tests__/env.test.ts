import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  envFirst,
  envNumber,
  envOptionalUrl,
  envString,
  envUrl,
  envUrlList,
  isAbsoluteHttpUrl,
} from '../env';

// ホスティング環境では「変数名だけ登録されて値が空」という状態が起こる。
// 素朴な `?? 既定値` はこれを拾えず、空文字のまま相対 URL を fetch して失敗する。
test('空文字・空白のみは未設定として扱う', () => {
  assert.equal(envString(undefined), undefined);
  assert.equal(envString(null), undefined);
  assert.equal(envString(''), undefined);
  assert.equal(envString('   '), undefined);
  assert.equal(envString(' https://example.com '), 'https://example.com');
});

test('envFirst は実際に値が入っている最初のものを返す', () => {
  assert.equal(envFirst('', '  ', 'https://b.example'), 'https://b.example');
  assert.equal(envFirst(undefined, ''), undefined);
});

test('isAbsoluteHttpUrl は http/https のみ許可する', () => {
  assert.equal(isAbsoluteHttpUrl('https://example.com'), true);
  assert.equal(isAbsoluteHttpUrl('http://localhost:8002'), true);
  assert.equal(isAbsoluteHttpUrl('/search'), false);
  assert.equal(isAbsoluteHttpUrl('example.com'), false);
  assert.equal(isAbsoluteHttpUrl('file:///etc/passwd'), false);
});

test('envUrl は空文字・相対 URL を既定値に落とす', () => {
  const fallback = 'https://nominatim.openstreetmap.org';
  assert.equal(envUrl('', fallback), fallback);
  assert.equal(envUrl(undefined, fallback), fallback);
  assert.equal(envUrl('/search', fallback), fallback);
  assert.equal(envUrl('https://nominatim.example.jp/', fallback), 'https://nominatim.example.jp');
});

test('envOptionalUrl は不正な値を undefined にする', () => {
  assert.equal(envOptionalUrl(''), undefined);
  assert.equal(envOptionalUrl('not a url'), undefined);
  assert.equal(envOptionalUrl('http://localhost:5000/route/v1/driving'), 'http://localhost:5000/route/v1/driving');
});

test('envUrlList は有効な URL だけを残し、空なら既定値を使う', () => {
  const fallback = ['https://overpass-api.de/api/interpreter'];
  assert.deepEqual(envUrlList('', fallback), fallback);
  assert.deepEqual(envUrlList('   ,  ', fallback), fallback);
  assert.deepEqual(envUrlList('bogus,also-bogus', fallback), fallback);
  assert.deepEqual(envUrlList('https://a.example/i, https://b.example/i', fallback), [
    'https://a.example/i',
    'https://b.example/i',
  ]);
});

test('envNumber は空文字・非数値を既定値にする', () => {
  assert.equal(envNumber('', 20000), 20000);
  assert.equal(envNumber('abc', 20000), 20000);
  assert.equal(envNumber('5000', 20000), 5000);
});
