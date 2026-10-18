#!/usr/bin/env node
// Strips credentials from load-test output before it can be committed:
//   - k6's --summary-export writes setup()'s return value as setup_data; quests.js
//     returns the Clerk session IDs of its test users, so that key is dropped
//   - anything that still looks like a Clerk ID (sess_, user_, client_, ...), a JWT or a
//     Clerk secret key is replaced, wherever it is (k6.log quotes failed Clerk URLs)
//
//   node loadtest/redact.js <dir|file>...           # rewrite in place (the run scripts call this)
//   node loadtest/redact.js --check <dir|file>...   # list leaks and exit 1 (CI)
const fs = require('fs');
const path = require('path');

const PATTERNS = [
  [/\b(sess|user|client|sms|idn|org|ins|sk_test|sk_live)_[A-Za-z0-9]{20,}\b/g, '$1_REDACTED'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, 'JWT_REDACTED'],
];

const args = process.argv.slice(2);
const check = args[0] === '--check';
const roots = check ? args.slice(1) : args;
if (!roots.length) {
  console.error('usage: redact.js [--check] <dir|file>...');
  process.exit(2);
}

function* files(p) {
  if (!fs.existsSync(p)) return;
  if (!fs.statSync(p).isDirectory()) return yield p;
  for (const e of fs.readdirSync(p)) yield* files(path.join(p, e));
}

function redact(text, file) {
  if (file.endsWith('.json') && text.includes('"setup_data"')) {
    try {
      const j = JSON.parse(text);
      delete j.setup_data;
      // k6 writes setup_data last: cut it off so the rest stays as k6 wrote it, or
      // re-serialize if the cut doesn't give the same document.
      const cut = text.slice(0, text.lastIndexOf('"setup_data"')).replace(/,\s*$/, '') + '\n}\n';
      let same = false;
      try { same = JSON.stringify(JSON.parse(cut)) === JSON.stringify(j); } catch {}
      text = same ? cut : JSON.stringify(j, null, 4) + '\n';
    } catch {} // not one JSON document: the patterns below still apply
  }
  for (const [re, sub] of PATTERNS) text = text.replace(re, sub);
  return text;
}

let leaks = 0;
for (const root of roots) {
  for (const f of files(root)) {
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) continue; // binary (e.g. a CPU profile)
    const text = buf.toString('utf8');
    const clean = redact(text, f);
    if (clean === text) continue;
    if (check) {
      const found = new Set();
      if (f.endsWith('.json') && text.includes('"setup_data"')) found.add('setup_data');
      // Print the kind (sess_…), never the ID itself: CI logs are public.
      for (const [re] of PATTERNS) for (const m of text.match(re) || []) found.add(m.replace(/^(eyJ|[a-z_]+?_).*/s, '$1…'));
      console.log(`${f}: ${[...found].slice(0, 5).join(', ')}${found.size > 5 ? ` (+${found.size - 5})` : ''}`);
      leaks++;
    } else {
      fs.writeFileSync(f, clean);
    }
  }
}
if (check && leaks) {
  console.error(`${leaks} file(s) contain session IDs, tokens or setup_data: run node loadtest/redact.js on them`);
  process.exit(1);
}
