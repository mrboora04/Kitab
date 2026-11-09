# Kitab sources (the extension store)

The extension store for [Kitab](https://github.com/mrboora04/Kitab), kept in this `store/` folder: small, safe recipes that let the app find **free, public books** on the web. One link, like a Mihon extension repository.

## Add it in Kitab

It is already built in. To add it by hand: **Browse → Extensions → Repositories → Add**, and paste

```
https://raw.githubusercontent.com/mrboora04/Kitab/main/store/index.json
```

Then tap the download arrow next to a source. It shows up under **Browse → Sources**.

## What is in here

| Source | What it reads | Books |
|---|---|---|
| Free Scanned Books | archive.org | Scanned books that are free to read on the Internet Archive (no lending-library items), with a list per language |
| Open Library (free scans) | openlibrary.org, archive.org | Free scans anyone can borrow or download, EPUB and PDF |
| Wikisource | en.wikisource.org | Free texts, exported as EPUB |

Project Gutenberg and Standard Ebooks are built into Kitab itself, so they are not repeated here.

## Why it is safe

Mihon extensions are real Android programs, so they have to be signed and trusted. Kitab sources are **not programs**. A source is a JSON recipe that says *which addresses to ask* and *where in the answer the title, cover and download links are*. Kitab runs the recipe itself, so a source:

- **cannot run code** on your phone or touch other apps or files;
- **can only contact the websites it lists** (`hosts`). Anything else is stopped, including redirects and download links;
- is **checked against a checksum** in `index.json` before it is installed, so a changed file is refused;
- must say what kind of books it offers (`license`), and sources with adult content are refused.

Kitab only supports sources of books that are free to read: public domain, open access, or openly licensed. Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing one.

## Make your own repository

A repository is just a folder with an `index.json` and the source files it lists, hosted anywhere over https (GitHub works). Copy this `store/` folder, add your sources in `sources/`, run `node tools/build-index.mjs`, and share the link to your `index.json`. The format is in [SOURCE_FORMAT.md](SOURCE_FORMAT.md).

## Disclaimer

Kitab and this repository host no books. Sources only point at websites that publish them. Whether a book is free to read where you live is for you to check.
