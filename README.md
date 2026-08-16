# site-shots

Full-page screenshots of every page on a site, local or remote.

![site-shots gallery of stripe.com](docs/gallery.png)

```sh
npm install
node shoot.mjs https://myapp.test
node shoot.mjs https://example.com --max 50
node shoot.mjs --help
```

Output: `shots/<host>/*.png`, `shots/manifest.json`, `shots/index.html`, `<host>-pages-<timestamp>.zip`.

## Auth

```sh
node shoot.mjs https://myapp.test --login                    # sign in in the browser window, saved to auth/<host>.json
node shoot.mjs https://myapp.test --auth auth/myapp.test.json
node shoot.mjs https://myapp.test --cookie "session=abc"
node shoot.mjs https://myapp.test --header "Authorization: Bearer xyz"
node shoot.mjs https://myapp.test --basic user:pass
```

## Options

```
--max <n>              --depth <n>            --concurrency <n>
--scope domain|host    --allow-host <host>    --seed <url>
--ignore <regex>       --only <regex>         --keep-query        --no-sitemap
--viewport WxH         --device "iPhone 13"   --dark              --wait <ms>
--timeout <ms>         --dismiss <selector>   --no-scroll         --headed
--out <dir>            --no-zip
```

Subdomains are crawled by default. Off-site redirects and non-HTML responses are listed as `skipped`. Unlinked pages need `--seed`.
