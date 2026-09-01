'use strict';

/** Contract test for independently relocatable route-engine mutable data. */
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const enginePaths = require('../src/route/engine-paths');

const override = path.resolve('tmp-route-data-contract');
assert.equal(
  enginePaths.engineDataDir({
    route_engine_dir: path.resolve('route-engine'),
    route_engine_data_dir: override,
  }),
  override
);

const python = process.env.PYTHON || 'python';
const script = path.resolve(__dirname, '../route-engine/src/generate_shopping_route.py');
const help = spawnSync(python, [script, '--help'], { encoding: 'utf8' });
assert.equal(help.status, 0, help.stderr || help.stdout);
assert.match(help.stdout, /--data-dir/);

console.log('PASS — Node and Python route-engine layers share the mutable data override');
