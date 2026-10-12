import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/main.js'], bundle: true, write: false, format: 'iife', minify: true, target: ['chrome100', 'safari15.4'], legalComments: 'inline' });
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/\/\*![\s\S]*?\*\//g, comment => comment.replace(/^ +\t/gm, '    '));
const css = await readFile('src/styles.css', 'utf8');
const template = await readFile('src/index.html', 'utf8');
await writeFile('index.html', template.replace('/* APP_CSS */', () => css).replace('/* APP_JS */', () => js), 'utf8');
console.log('已生成根目录 index.html（官方SDK内置，可直接由GitHub Pages托管）');
