'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
fs.mkdirSync(path.resolve(__dirname, '..', 'test-results'), { recursive: true });
for (const file of ['tags.cjs', 'progress.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
