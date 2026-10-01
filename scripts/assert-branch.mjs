#!/usr/bin/env node
// Deploy guard: node scripts/assert-branch.mjs <branch>
// Blocks a deploy unless HEAD is <branch>, the tree is clean, and HEAD == origin/<branch>
// (what ships to Firebase is exactly what is on GitHub).
import { execSync } from 'node:child_process';

const want = process.argv[2];
if (!want) { console.error('usage: assert-branch.mjs <branch>'); process.exit(1); }

const sh = cmd => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = msg => { console.error(`✖ Deploy blocked: ${msg}`); process.exit(1); };

const branch = sh('git rev-parse --abbrev-ref HEAD');
if (branch !== want) fail(`on '${branch}', expected '${want}'.`);
if (sh('git status --porcelain')) fail('working tree not clean. Commit or stash first.');

sh(`git fetch origin ${want} --quiet`);
if (sh('git rev-parse HEAD') !== sh(`git rev-parse origin/${want}`)) {
    fail(`local ${want} differs from origin/${want}. Push or pull first.`);
}
console.log(`✔ Branch guard passed: ${want} @ ${sh('git rev-parse --short HEAD')}`);
