'use strict';

/** Offline regression tests for atomic OAuth token persistence. */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TokenManager } = require('../src/auth/token-manager');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ued-token-store-'));
let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  — ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`  FAIL — ${name}\n       ${err.stack || err.message}`);
  }
}

(async () => {
try {
  await test('writes a complete token store and leaves no temp file', () => {
    const file = path.join(tempRoot, 'tokens.json');
    const manager = new TokenManager(file);
    manager.storeTokens('shop-1', {
      access_token: '1.access',
      refresh_token: '1.refresh',
      expires_in: 3600,
      scope: 'transactions_r listings_r',
    });

    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored['shop-1'].refresh_token, '1.refresh');
    assert.deepEqual(stored['shop-1'].scopes, ['transactions_r', 'listings_r']);
    assert.deepEqual(
      fs.readdirSync(tempRoot).filter((name) => name.endsWith('.tmp')),
      []
    );
  });

  await test('atomically replaces an existing store without losing other shops', () => {
    const file = path.join(tempRoot, 'replace.json');
    const manager = new TokenManager(file);
    manager.storeTokens('shop-1', {
      access_token: '1.a',
      refresh_token: '1.r',
    });
    manager.storeTokens('shop-2', {
      access_token: '2.a',
      refresh_token: '2.r',
    });
    const reloaded = new TokenManager(file);
    assert.equal(reloaded.hasTokens('shop-1'), true);
    assert.equal(reloaded.hasTokens('shop-2'), true);
  });

  await test('corrupt JSON is backed up and can never be overwritten', () => {
    const file = path.join(tempRoot, 'corrupt.json');
    const corrupt = '{"shop-1":';
    fs.writeFileSync(file, corrupt, 'utf8');
    const manager = new TokenManager(file);
    assert.throws(
      () => manager.storeTokens('shop-2', {
        access_token: '2.a',
        refresh_token: '2.r',
      }),
      (err) => err && err.code === 'TOKEN_STORE_INVALID'
    );
    assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
    const backups = fs.readdirSync(tempRoot).filter((name) => name.startsWith('corrupt.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(tempRoot, backups[0]), 'utf8'), corrupt);
    assert.equal(manager.getStatus(['shop-1'])[0].status, 'token_store_invalid');
    assert.equal(manager.getStoreHealth().valid, false);
  });

  await test('corrupt store blocks refresh before any token endpoint call', async () => {
    const file = path.join(tempRoot, 'no-refresh.json');
    fs.writeFileSync(file, '{"broken":', 'utf8');
    const manager = new TokenManager(file);
    let calls = 0;
    const proxyClient = {
      post: async () => {
        calls += 1;
        return {
          data: {
            access_token: 'new.access',
            refresh_token: 'new.refresh',
            expires_in: 3600,
          },
        };
      },
    };
    await assert.rejects(
      manager.getAccessToken('shop-1', 'key', 'fallback.refresh', proxyClient),
      (err) => err && err.code === 'TOKEN_STORE_INVALID'
    );
    assert.equal(calls, 0);
  });

  await test('invalidate degrades safely after a valid store becomes corrupt', () => {
    const file = path.join(tempRoot, 'invalidate.json');
    const manager = new TokenManager(file);
    manager.storeTokens('shop-1', {
      access_token: '1.access',
      refresh_token: '1.refresh',
    });
    fs.writeFileSync(file, '{"broken":', 'utf8');
    manager.reload();
    assert.equal(manager.invalidate('shop-1'), false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{"broken":');
  });

  await test('refresh keeps rotated tokens in memory when disk save fails', async () => {
    const file = path.join(tempRoot, 'transient-save.json');
    const manager = new TokenManager(file);
    manager.storeTokens('shop-1', {
      access_token: 'old.access',
      refresh_token: 'old.refresh',
      expires_in: 0,
    });
    manager._save = () => { throw new Error('disk full'); };
    manager._schedulePersistenceRetry = () => {};
    const access = await manager.getAccessToken(
      'shop-1',
      'key',
      null,
      {
        post: async () => ({
          data: {
            access_token: 'new.access',
            refresh_token: 'new.refresh',
            expires_in: 3600,
          },
        }),
      }
    );
    assert.equal(access, 'new.access');
    assert.equal(manager._store['shop-1'].refresh_token, 'new.refresh');
    assert.equal(manager.getStoreHealth().persisted, false);
    assert.equal(manager.getStatus(['shop-1'])[0].status, 'token_store_unpersisted');
  });
} finally {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
