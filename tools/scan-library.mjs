// Scan Wallpaper Engine workshop library: parse each project.json, classify type,
// find the main media file, and print a summary table.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || 'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960';
const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
const rows = [];
for (const d of dirs) {
  const pj = path.join(root, d.name, 'project.json');
  if (!fs.existsSync(pj)) continue;
  let meta; try { meta = JSON.parse(fs.readFileSync(pj, 'utf8')); } catch { continue; }
  const type = (meta.type || 'unknown').toLowerCase();
  const file = meta.file || '';
  const full = file ? path.join(root, d.name, file) : '';
  const exists = file && fs.existsSync(full);
  const size = exists ? fs.statSync(full).size : 0;
  const preview = meta.preview && fs.existsSync(path.join(root, d.name, meta.preview)) ? path.join(root, d.name, meta.preview) : '';
  rows.push({ id: d.name, type, title: meta.title || '', file, sizeMB: +(size / 1048576).toFixed(1), exists: !!exists, preview: !!preview });
}
const byType = {};
for (const r of rows) byType[r.type] = (byType[r.type] || 0) + 1;
console.log('Total with project.json:', rows.length);
console.log('By type:', JSON.stringify(byType));
console.log('\nVideo wallpapers (playable directly):');
for (const r of rows.filter((r) => r.type === 'video' && r.exists).sort((a, b) => b.sizeMB - a.sizeMB))
  console.log(`  ${r.id}  ${String(r.sizeMB).padStart(8)} MB  ${r.title.slice(0, 60)}  [${r.file}]`);
console.log('\nScene/web wallpapers have main files but need renderers:');
for (const r of rows.filter((r) => (r.type === 'scene' || r.type === 'web') && r.exists).slice(0, 10))
  console.log(`  ${r.id}  ${r.type}  ${r.title.slice(0, 50)}  [${r.file}]`);
