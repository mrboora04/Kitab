# Adding a source

Thank you for helping people find free books. Please read this first.

## What belongs here

Only sources of books that are **free to read legally**: public domain, open access, or openly licensed (Creative Commons and similar). The `license` field must say so truthfully.

**Not accepted:** sites that host copyrighted books without permission, adult content, anything that needs a login or payment to get around, and anything that tries to get past a site's blocking or limits.

Please also respect the site: read only what a person would read, do not hammer it, and prefer an official API or catalog over scraping a page.

## How

1. Copy a file in `sources/` and change it. The format is in [SOURCE_FORMAT.md](SOURCE_FORMAT.md).
2. List every website the source touches in `hosts` (and cover picture sites in `coverHosts`).
3. Run `cd store && node tools/build-index.mjs`. It checks your file and updates `index.json`.
4. Try it in Kitab: add your repository link, install the source, search, open a book, download it.
5. Open a pull request. The pull request template asks for the checks above.

When you change an existing source, **raise its `version`**.

## Review checklist

- [ ] Only free, legal books. `license` is accurate.
- [ ] `hosts` is as small as possible; no `*.` wildcards unless needed.
- [ ] Works in Kitab (search, open, download).
- [ ] `node tools/build-index.mjs --check` passes.
- [ ] Version raised if this changes an existing source.
