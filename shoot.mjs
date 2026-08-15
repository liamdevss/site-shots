#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const exec = promisify(execFile);
const toolDir = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
site-shots — screenshot every page of a website

Usage:
  node shoot.mjs <url> [options]

Crawl
  --max <n>              Stop after this many pages (default 300)
  --depth <n>            Max link depth from the start URL (default unlimited)
  --concurrency <n>      Pages shot in parallel (default 4)
  --scope <domain|host>  domain: any subdomain of the site (default); host: exact host only
  --allow-host <host>    Extra host to treat as in-scope (repeatable)
  --ignore <regex>       Skip URLs matching this regex (repeatable; logout/download/etc. always skipped)
  --only <regex>         Only crawl URLs matching this regex (repeatable)
  --keep-query           Treat ?query strings as distinct pages (default: stripped)
  --no-sitemap           Don't seed URLs from /sitemap.xml
  --seed <url>           Extra start URL (repeatable)

Auth
  --login                Open a real browser window, sign in yourself, press Enter here to continue
  --login-url <url>      Page to open for --login (default: the start URL)
  --auth <file>          Reuse a saved Playwright storage state (written by --login)
  --cookie <name=value>  Set a cookie for the site (repeatable)
  --header <"K: V">      Extra HTTP header on every request (repeatable)
  --basic <user:pass>    HTTP basic auth

Page
  --viewport <WxH>       Browser size (default 1440x900)
  --device <name>        Emulate a Playwright device, e.g. "iPhone 13"
  --dark                 Prefer dark colour scheme
  --wait <ms>            Extra settle time before each shot (default 300)
  --timeout <ms>         Per-page navigation timeout (default 30000)
  --dismiss <selector>   Click this if present before shooting (cookie banners etc., repeatable)
  --no-scroll            Don't auto-scroll to trigger lazy-loaded content
  --headed               Show the browser while crawling

Output
  --out <dir>            Output directory (default ./shots)
  --no-zip               Skip building the zip
  -h, --help             This help
`.trimStart();

const { values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        max: { type: 'string', default: '300' },
        depth: { type: 'string' },
        concurrency: { type: 'string', default: '4' },
        scope: { type: 'string', default: 'domain' },
        'allow-host': { type: 'string', multiple: true, default: [] },
        ignore: { type: 'string', multiple: true, default: [] },
        only: { type: 'string', multiple: true, default: [] },
        'keep-query': { type: 'boolean', default: false },
        'no-sitemap': { type: 'boolean', default: false },
        seed: { type: 'string', multiple: true, default: [] },
        login: { type: 'boolean', default: false },
        'login-url': { type: 'string' },
        auth: { type: 'string' },
        cookie: { type: 'string', multiple: true, default: [] },
        header: { type: 'string', multiple: true, default: [] },
        basic: { type: 'string' },
        viewport: { type: 'string', default: '1440x900' },
        device: { type: 'string' },
        dark: { type: 'boolean', default: false },
        wait: { type: 'string', default: '300' },
        timeout: { type: 'string', default: '30000' },
        dismiss: { type: 'string', multiple: true, default: [] },
        'no-scroll': { type: 'boolean', default: false },
        headed: { type: 'boolean', default: false },
        out: { type: 'string' },
        'no-zip': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
    },
});

if (opts.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(opts.help ? 0 : 1);
}

let startUrl;
try {
    let raw = positionals[0];
    if (!/^[a-z]+:\/\//i.test(raw)) raw = (raw.startsWith('localhost') || /^[\d.]+(:\d+)?$/.test(raw) ? 'http://' : 'https://') + raw;
    startUrl = new URL(raw);
} catch {
    console.error(`Not a valid URL: ${positionals[0]}`);
    process.exit(1);
}

const MAX_PAGES = Number(opts.max);
const MAX_DEPTH = opts.depth === undefined ? Infinity : Number(opts.depth);
const CONCURRENCY = Math.max(1, Number(opts.concurrency));
const WAIT_MS = Number(opts.wait);
const TIMEOUT_MS = Number(opts.timeout);
const KEEP_QUERY = opts['keep-query'];
const [vw, vh] = opts.viewport.split('x').map(Number);
const VIEWPORT = { width: vw || 1440, height: vh || 900 };
const outDir = path.resolve(opts.out ?? path.join(toolDir, 'shots'));

const ALWAYS_IGNORE = /(^|\/)(logout|log-out|sign-?out|signout|download|export|delete|destroy|unsubscribe)(\/|$|\?|\.)/i;
const IGNORE = opts.ignore.map((r) => new RegExp(r, 'i'));
const ONLY = opts.only.map((r) => new RegExp(r, 'i'));
const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|css|js|mjs|map|json|xml|rss|atom|pdf|zip|gz|tar|rar|7z|dmg|exe|mp4|webm|mp3|wav|ogg|woff2?|ttf|otf|eot|txt|csv|xlsx?|docx?|pptx?)$/i;

function rootDomain(hostname) {
    if (hostname === 'localhost' || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return hostname;
    const parts = hostname.split('.');
    return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

const startHost = startUrl.hostname.replace(/^www\./, '');
const startRoot = rootDomain(startUrl.hostname);
const startPort = startUrl.port;
const allowHosts = new Set(opts['allow-host'].map((h) => h.toLowerCase()));

function inScope(url) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (allowHosts.has(host) || allowHosts.has(url.host.toLowerCase())) return true;
    if (url.port !== startPort) return false;
    const bare = host.replace(/^www\./, '');
    if (bare === startHost) return true;
    if (opts.scope === 'host') return false;
    return bare === startRoot || bare.endsWith(`.${startRoot}`);
}

function normalize(href, base) {
    let url;
    try {
        url = new URL(href, base);
    } catch {
        return null;
    }
    if (!inScope(url)) return null;
    url.hash = '';
    if (!KEEP_QUERY) url.search = '';
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.slice(0, -1);
    url.hostname = url.hostname.toLowerCase();
    if (SKIP_EXT.test(url.pathname)) return null;
    const s = url.toString();
    if (ALWAYS_IGNORE.test(url.pathname)) return null;
    if (IGNORE.some((r) => r.test(s))) return null;
    if (ONLY.length && !ONLY.some((r) => r.test(s))) return null;
    return s;
}

function short(url, n = 90) {
    return url.length > n ? `${url.slice(0, n)}…` : url;
}

function slugFor(url) {
    const u = new URL(url);
    let slug = decodeURIComponent(u.pathname).replace(/^\/+|\/+$/g, '');
    if (u.search) slug += `_${u.search.slice(1)}`;
    slug = slug.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'index';
    if (slug.length > 120) slug = `${slug.slice(0, 110)}-${createHash('md5').update(url).digest('hex').slice(0, 8)}`;
    return slug;
}

function parseHeaders(lines) {
    const out = {};
    for (const line of lines) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    return out;
}

function parseCookies(list) {
    return list.map((c) => {
        const i = c.indexOf('=');
        return {
            name: c.slice(0, i).trim(),
            value: c.slice(i + 1).trim(),
            domain: opts.scope === 'host' ? startUrl.hostname : `.${startRoot}`,
            path: '/',
            secure: startUrl.protocol === 'https:',
        };
    });
}

async function exists(file) {
    return access(file).then(() => true, () => false);
}

async function loadSitemap(request, url, seen = new Set(), depth = 0) {
    if (seen.has(url) || depth > 3) return [];
    seen.add(url);
    let body;
    try {
        const res = await request.get(url, { timeout: 15_000 });
        if (!res.ok()) return [];
        body = await res.text();
    } catch {
        return [];
    }
    const locs = [...body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].trim());
    if (/<sitemapindex/i.test(body)) {
        const nested = await Promise.all(locs.map((l) => loadSitemap(request, l, seen, depth + 1)));
        return nested.flat();
    }
    return locs;
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        const step = Math.max(300, window.innerHeight * 0.8);
        const limit = Math.min(document.body.scrollHeight, 25_000);
        for (let y = 0; y < limit; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 60));
        }
        window.scrollTo(0, 0);
    }).catch(() => {});
}

function contextOptions(storageState) {
    const device = opts.device ? devices[opts.device] : null;
    if (opts.device && !device) {
        console.error(`Unknown device "${opts.device}". Try e.g. "iPhone 13", "Pixel 7", "iPad Pro 11".`);
        process.exit(1);
    }
    const o = {
        ...(device ?? { viewport: VIEWPORT }),
        ignoreHTTPSErrors: true,
        reducedMotion: 'reduce',
        colorScheme: opts.dark ? 'dark' : 'light',
        extraHTTPHeaders: parseHeaders(opts.header),
    };
    if (opts.basic) {
        const i = opts.basic.indexOf(':');
        o.httpCredentials = { username: opts.basic.slice(0, i), password: opts.basic.slice(i + 1) };
    }
    if (storageState) o.storageState = storageState;
    return o;
}

async function interactiveLogin(authFile) {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext(contextOptions());
    if (opts.cookie.length) await context.addCookies(parseCookies(opts.cookie));
    const page = await context.newPage();
    await page.goto(opts['login-url'] ?? startUrl.toString(), { waitUntil: 'domcontentloaded' }).catch(() => {});

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('\nSign in in the browser window, then press Enter here to continue... ');
    rl.close();

    await mkdir(path.dirname(authFile), { recursive: true });
    await context.storageState({ path: authFile });
    await browser.close();
    console.log(`Session saved to ${path.relative(process.cwd(), authFile)} (reuse with --auth)`);
    return authFile;
}

async function shoot(context, target, state) {
    const page = await context.newPage();
    try {
        const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
        const status = response?.status() ?? 0;
        if (status >= 400) return { ...target, status, ok: false, reason: `HTTP ${status}` };

        const finalUrl = page.url();
        const finalNorm = normalize(finalUrl, finalUrl);
        if (!finalNorm) return { ...target, status, ok: false, skipped: true, reason: `redirects off-site to ${short(finalUrl)}` };
        if (finalNorm !== target.url) {
            if (state.seen.has(finalNorm)) return { ...target, status, ok: false, skipped: true, reason: `redirects to ${short(finalNorm)} (already captured)` };
            state.seen.add(finalNorm);
        }

        const contentType = (await response?.headerValue('content-type')) ?? '';
        if (contentType && !/text\/html|application\/xhtml/.test(contentType)) {
            return { ...target, status, ok: false, skipped: true, reason: `not a page (${contentType.split(';')[0]})` };
        }

        await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
        for (const sel of opts.dismiss) {
            await page.locator(sel).first().click({ timeout: 1_000 }).catch(() => {});
        }
        if (!opts['no-scroll']) await autoScroll(page);
        await page.addStyleTag({ content: '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }' }).catch(() => {});
        await page.waitForTimeout(WAIT_MS);

        const hrefs = await page.$$eval('a[href], area[href]', (els) => els.map((e) => e.getAttribute('href'))).catch(() => []);
        const links = new Set();
        for (const h of hrefs) {
            if (!h || /^(mailto:|tel:|javascript:|sms:|data:)/i.test(h)) continue;
            const n = normalize(h, finalUrl);
            if (n) links.add(n);
        }

        const host = new URL(finalUrl).host;
        const file = path.join(outDir, host, `${slugFor(finalNorm)}.png`);
        await mkdir(path.dirname(file), { recursive: true });
        await page.screenshot({ path: file, fullPage: true, timeout: TIMEOUT_MS });
        const title = await page.title().catch(() => '');

        return { ...target, status, ok: true, finalUrl, title, file: path.relative(outDir, file), links: [...links] };
    } catch (error) {
        return { ...target, ok: false, reason: String(error.message ?? error).split('\n')[0] };
    } finally {
        await page.close();
    }
}

async function run() {
    const started = Date.now();
    console.log(`site-shots → ${startUrl}  (scope: ${opts.scope === 'host' ? startUrl.host : `*.${startRoot}`}, max ${MAX_PAGES} pages)`);

    let storageState = opts.auth ? path.resolve(opts.auth) : null;
    if (opts.login) {
        storageState = await interactiveLogin(storageState ?? path.join(toolDir, 'auth', `${startUrl.hostname}.json`));
    } else if (storageState && !(await exists(storageState))) {
        console.error(`Auth file not found: ${storageState} (create it with --login)`);
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: !opts.headed });
    const context = await browser.newContext(contextOptions(storageState));
    if (opts.cookie.length) await context.addCookies(parseCookies(opts.cookie));
    context.setDefaultTimeout(TIMEOUT_MS);

    const state = { seen: new Set() };
    const queue = [];
    const enqueue = (url, depth) => {
        const n = normalize(url, startUrl);
        if (!n || state.seen.has(n)) return;
        state.seen.add(n);
        queue.push({ url: n, depth });
    };
    enqueue(startUrl.toString(), 0);
    for (const s of opts.seed) enqueue(s, 0);
    if (!opts['no-sitemap']) {
        const locs = await loadSitemap(context.request, `${startUrl.origin}/sitemap.xml`);
        for (const l of locs) enqueue(l, 1);
        if (locs.length) console.log(`Seeded ${locs.length} URLs from sitemap.xml`);
    }

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    const results = [];
    let shotCount = 0;
    let active = 0;
    await new Promise((resolve) => {
        const pump = () => {
            while (active < CONCURRENCY && queue.length && shotCount + active < MAX_PAGES) {
                const item = queue.shift();
                active++;
                shoot(context, item, state).then((r) => {
                    active--;
                    results.push(r);
                    if (r.ok) {
                        shotCount++;
                        console.log(`  [${shotCount}] ${r.finalUrl}`);
                        if (item.depth < MAX_DEPTH) for (const l of r.links) enqueue(l, item.depth + 1);
                    } else {
                        console.log(`  ${r.skipped ? '–' : '✗'} ${short(r.url)} — ${r.reason}`);
                    }
                    pump();
                });
            }
            if (active === 0 && (queue.length === 0 || shotCount >= MAX_PAGES)) resolve();
        };
        pump();
    });

    const capped = shotCount >= MAX_PAGES && queue.length > 0;
    await browser.close();

    const ok = results.filter((r) => r.ok).map(({ links, ...r }) => r);
    const failed = results.filter((r) => !r.ok && !r.skipped);
    const skipped = [
        ...results.filter((r) => r.skipped).map(({ skipped, ok, ...r }) => r),
        ...(capped ? queue.map((q) => ({ url: q.url, reason: `--max ${MAX_PAGES} reached` })) : []),
    ];
    const manifest = {
        generatedAt: new Date().toISOString(),
        startUrl: startUrl.toString(),
        scope: opts.scope,
        authenticated: Boolean(storageState || opts.cookie.length || opts.basic || opts.header.length),
        viewport: opts.device ?? `${VIEWPORT.width}x${VIEWPORT.height}`,
        shot: ok,
        failed,
        skipped,
    };
    await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(outDir, 'index.html'), gallery(manifest));

    let zipPath = null;
    if (!opts['no-zip']) {
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        zipPath = path.join(path.dirname(outDir), `${startUrl.hostname}-pages-${stamp}.zip`);
        await rm(zipPath, { force: true });
        await exec('zip', ['-qr', zipPath, '.'], { cwd: outDir }).catch((e) => {
            console.warn(`(zip failed: ${e.message.split('\n')[0]})`);
            zipPath = null;
        });
    }

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`\nDone in ${secs}s: ${ok.length} pages captured, ${failed.length} failed, ${skipped.length} skipped${capped ? ` (${queue.length} left in queue — raise --max)` : ''}.`);
    for (const f of failed) console.log(`  ✗ ${short(f.url)}: ${f.reason}`);
    console.log(`\nShots: ${outDir}\nGallery: ${path.join(outDir, 'index.html')}`);
    if (zipPath) console.log(`Zip: ${zipPath}`);
}

function gallery(m) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const cards = m.shot.map((s) => `
      <a class="card" href="${esc(s.file)}" target="_blank">
        <div class="thumb"><img loading="lazy" src="${esc(s.file)}" alt=""></div>
        <div class="meta"><strong>${esc(s.title || '(untitled)')}</strong><span>${esc(s.finalUrl)}</span></div>
      </a>`).join('');
    const fails = m.failed.map((f) => `<li><code>${esc(f.url)}</code> — ${esc(f.reason)}</li>`).join('');
    return `<!doctype html><meta charset="utf-8"><title>site-shots: ${esc(m.startUrl)}</title>
<style>
  body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:24px;background:#f4f4f5;color:#18181b}
  h1{font-size:18px;margin:0 0 4px} p{margin:0 0 20px;color:#52525b}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
  .card{display:block;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);color:inherit;text-decoration:none}
  .thumb{height:200px;overflow:hidden;background:#e4e4e7}.thumb img{width:100%;display:block}
  .meta{padding:10px 12px;display:grid;gap:2px}.meta span{font-size:12px;color:#71717a;word-break:break-all}
  ul{margin-top:32px;color:#71717a}code{font-size:12px}
</style>
<h1>${esc(m.startUrl)}</h1>
<p>${m.shot.length} pages captured · ${m.failed.length} failed · ${m.skipped.length} skipped · ${esc(m.generatedAt)} · ${esc(m.viewport)}</p>
<div class="grid">${cards}</div>
${fails ? `<h2 style="font-size:15px;margin-top:32px">Failed</h2><ul>${fails}</ul>` : ''}`;
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
