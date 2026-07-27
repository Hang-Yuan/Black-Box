#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write('2.1.0 (Black Box lifecycle fixture)\n');
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_PID_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_PID_FILE, `${process.pid}\n`, 'utf8');
}

setInterval(() => {}, 60_000);
