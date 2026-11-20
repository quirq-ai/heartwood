// Optional: copies the scene's level-of-detail files (about 126 MB) into public/scene/, so a
// deploy serves them itself instead of streaming them from PlayCanvas's CDN.
//
//   node scripts/fetch-scene.mjs [lod-meta.json url]
//
// Then set SCENE.url in src/config.js to 'scene/lod-meta.json' (or open the app with
// ?src=scene/lod-meta.json). Keep the CC BY 4.0 credit in place wherever it is published.
import fs from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'https://d28zzqy0iyovbz.cloudfront.net/6a8be890/v1/lod-meta.json';
const base = url.slice(0, url.lastIndexOf('/') + 1);
const out = path.resolve('public/scene');

async function get(rel) {
    const res = await fetch(base + rel);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${rel}`);
    return Buffer.from(await res.arrayBuffer());
}

async function save(rel, buffer) {
    const file = path.join(out, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, buffer);
}

const metaName = url.slice(base.length);
const metaBuffer = await get(metaName);
await save(metaName, metaBuffer);
const meta = JSON.parse(metaBuffer.toString('utf8'));

// every chunk is a SOG meta.json naming its own texture files
const files = [];
for (const name of meta.filenames ?? []) {
    const buffer = await get(name);
    await save(name, buffer);
    const dir = path.posix.dirname(name);
    const walk = (node) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
            for (const [key, value] of Object.entries(node)) {
                if (key === 'files' && Array.isArray(value)) value.forEach((f) => files.push(`${dir}/${f}`));
                else walk(value);
            }
        }
    };
    walk(JSON.parse(buffer.toString('utf8')));
}

let done = 0;
let bytes = 0;
const queue = [...new Set(files)];
const worker = async () => {
    while (queue.length) {
        const name = queue.shift();
        const buffer = await get(name);
        await save(name, buffer);
        bytes += buffer.length;
        done++;
        process.stdout.write(`\r${done} files, ${(bytes / 1048576).toFixed(1)} MB`);
    }
};
await Promise.all(Array.from({ length: 6 }, worker));
console.log(`\nSaved to ${out}. Set SCENE.url in src/config.js to 'scene/${metaName}'.`);
