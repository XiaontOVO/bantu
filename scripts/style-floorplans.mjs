import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { standardStyle, palette } from './lib/floorplan-design.mjs';

const directory = join(process.cwd(), 'public/images/places/floorplan');
for (const file of readdirSync(directory).filter(file => file.endsWith('.svg'))) {
  const path = join(directory, file);
  let source = readFileSync(path, 'utf8');
  source = source.replace(/<style id="bantu-(?:library-standard-v2|floorplan-standard-v3)">[\s\S]*?<\/style>\s*/g, '');
  const colors = new Map();
  const semantic = { shell: palette.shell, outer: palette.shell, room: palette.primary, gallery: palette.primary, exhibit: palette.primary, primary: palette.primary, deep: palette.primary, blue: palette.primary, stage: palette.primary, shop: palette.primary, retail: palette.primary, service: palette.service, core: palette.service, public: palette.public, lobby: palette.public, passage: palette.public, hall: palette.public, stair: palette.public, warm: palette.secondary, craft: palette.secondary, food: palette.secondary, dining: palette.secondary, gallery2: palette.secondary, green: '#d7e6dd', garden: '#d7e6dd', courtyard: '#d7e6dd', yard: '#d7e6dd', terrace: '#d7e6dd', private: palette.closed, void: palette.closed };
  for (const match of source.matchAll(/\.([\w-]+)\s*\{[^}]*?fill\s*:\s*(#[\da-fA-F]{6})\b[^}]*\}/g)) {
    if (semantic[match[1]] && !['#ffffff', '#fffefa', '#f5f6f5'].includes(match[2].toLowerCase())) colors.set(match[2].toLowerCase(), semantic[match[1]]);
  }
  // Keep the legend swatches in agreement with the spaces they describe.
  source = source.replace(/fill="(#[\da-fA-F]{6})"/g, (original, color) => colors.has(color.toLowerCase()) ? `fill="${colors.get(color.toLowerCase())}"` : original);
  source = source.replace(/(<g\b[^>]*\bfilter="[^"]+"[^>]*>\s*<path)(?![^>]*\bclass=)/g, '$1 class="plan-shell"');
  const width = Number(source.match(/viewBox="0 0 ([\d.]+)/)[1]);
  source = source.replace('</svg>', `${standardStyle(width)}\n</svg>`);
  writeFileSync(path, source, 'utf8');
}
