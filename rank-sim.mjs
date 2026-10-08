import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync(new URL('./tool-registry.json', import.meta.url), 'utf8'));
const list = Array.isArray(raw) ? raw : (raw.tools ?? []);
const LABELS = {};
for (const e of list) if (e && e.name) LABELS[e.name] = e;

const tokenise = (s) => String(s ?? '').toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'are',
  'but', 'not', 'can', 'all', 'any', 'use', 'via', 'how', 'what', 'when',
  'need', 'make', 'some', 'please', 'just', 'also', 'then', 'than', 'will',
  'would', 'should', 'could', 'been', 'being', 'does', 'done',
]);

function rank(query, names) {
  const terms = [...new Set(tokenise(query))].filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const scored = names.map((name) => {
    const rec = LABELS[name] || {};
    const hay = new Set(tokenise([name, rec.short, (rec.router_labels || []).join(' '), rec.description].join(' ')));
    const nameTokens = new Set(tokenise(name));
    let score = 0;
    for (const t of terms) {
      if (hay.has(t)) score += 1;
      if ([...nameTokens].some((n) => n === t || n.startsWith(t))) score += 3;
      if ((rec.router_labels || []).some((l) => l.toLowerCase().includes(t))) score += 2;
    }
    return { name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// The actual mounted surface of the no-prefill agent.
const mounted = ['bash', 'read', 'write', 'edit', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch', 'todo_write', 'present'];

for (const q of [
  'run a simple echo command to generate the content',
  'read the contents of a text file from disk',
  'create a file named hello.txt with the content hi',
  'search the codebase for a function definition',
]) {
  const ranked = rank(q, mounted);
  console.log('Q:', q);
  console.log('  TOP8:', ranked.slice(0, 8).map((r) => `${r.name}(${r.score})`).join(' '));
}
