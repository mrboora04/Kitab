# Source format (version 1)

A source is one JSON file in `sources/`, named `<id>.json`. `node tools/build-index.mjs` checks it and adds it to `index.json`.

## The basics

```json
{
  "schema": 1,
  "id": "example",
  "name": "Project Gutenberg (Gutendex)",
  "version": 1,
  "lang": "en",
  "license": "Public domain",
  "site": "https://www.gutenberg.org",
  "icon": "📚",
  "hosts": ["gutendex.com", "www.gutenberg.org"],
  "coverHosts": ["covers.example.org"],
  "type": "json"
}
```

| Field | Meaning |
|---|---|
| `schema` | Always `1`. |
| `id` | 2 to 40 characters: `a-z`, `0-9`, `-`. Must match the file name. |
| `version` | Whole number. **Raise it whenever the recipe changes** so Kitab offers an update. |
| `lang` | `en`, `fr`, ... or `multi`. |
| `license` | What kind of books it offers, e.g. `Public domain`. Required. |
| `hosts` | 1 to 6 website names the source may contact. `*.example.org` allows subdomains. Everything the source asks for, and every download link, must be on these. |
| `coverHosts` | Optional extra sites that cover pictures may come from. |
| `type` | `json`, `html` or `opds`. |

Every address in the file must be `https://` and on one of the `hosts`.

## `json`: a site with a data API

`search` describes how to search; `browse` lists named lists; `detail` is an optional second request for one book.

```json
"search": {
  "url": "https://gutendex.com/books/?search={q}&page={page}",
  "list": "results",
  "next": "next",
  "map": {
    "id": "id",
    "title": "title",
    "authors": "authors[].name",
    "summary": "summaries[]",
    "cover": "formats.image/jpeg",
    "formats": [
      { "format": "EPUB", "url": "formats.application/epub+zip" },
      { "format": "PDF",  "url": "formats.application/pdf" }
    ]
  }
},
"browse": [
  { "key": "popular", "label": "Popular", "url": "https://gutendex.com/books/?page={page}" }
]
```

- `{q}` is the search words (already safe for an address) and `{page}` is the page number, from 1.
- `list` is where the list of books is in the answer. A path like `a.b.c` follows keys; `[]` means "every item of this list" (`authors[].name`).
- `next` is where the answer holds the address of the next page. If the site uses page numbers instead, use `"pager": { "total": "response.numFound", "per": 25 }`.
- A value is a path (`"title"`) or a template (`{ "tpl": "https://x.org/img/{identifier}" }`) where `{path}` is filled from the book's data. If a part is missing the value is left empty. Write `{title|enc}` to make a value safe to put inside a web address, and `{ia.0}` for the first item of a list.
- A `browse` list can have its own `map`; otherwise it reads the answer the way `search` does.

### Two requests per book (`detail`)

Some sites only give the files on a second page:

```json
"detail": {
  "url": "https://archive.org/metadata/{identifier}",
  "summary": "metadata.description",
  "formats": {
    "list": "files",
    "field": "format",
    "as": { "EPUB": "EPUB", "Text PDF": "PDF" },
    "url": { "tpl": "https://archive.org/download/{identifier}/{name}" }
  }
}
```

Each item of `list` whose `field` value is a key of `as` becomes a download of that kind (`EPUB` or `PDF`). In the template, `{identifier}` comes from the book and `{name}` from the file.

## `html`: a plain web page

Selectors are CSS. `selector@attribute` reads an attribute (`a.next@href`); without `@` it reads the text. The page is parsed but never run.

```json
"search": {
  "url": "https://shelf.example.org/search?q={q}&p={page}",
  "list": "ul.results li",
  "next": "a.next@href",
  "map": { "title": "h3 a", "authors": ".by", "cover": "img@src", "link": "h3 a@href", "summary": ".blurb" }
},
"detail": {
  "summary": ".about",
  "formats": [
    { "format": "EPUB", "sel": "a.get-epub@href" },
    { "format": "PDF",  "sel": "a.get-pdf@href" }
  ]
}
```

`link` is the book's own page (read for `detail`). Links to other websites are dropped.

## `opds`: a catalog that already speaks OPDS

```json
{ "type": "opds", "start": "https://example.org/opds/", "search": "https://example.org/opds/search?q={searchTerms}" }
```

`search` is optional: Kitab uses the one the catalog advertises.

## Language filter (optional)

A source that can ask its site for one language declares how:

```json
"langFilter": { "param": "%20AND%20language%3A({v})", "values": { "hi": "hin%20OR%20Hindi", "pa": "pan%20OR%20Punjabi" } }
```

Put `{lang}` in the search address. When the reader picks a language in Kitab's search, `{lang}` becomes `param` with `{v}` replaced by that language's value; for All it is empty. A source without `langFilter` is only searched for its own `lang`.

## Limits

Files over 20 KB are refused. At most 60 books are read per page. Only `EPUB` and `PDF` downloads are used.
