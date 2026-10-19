# Release Notes

Add user-facing release notes as Markdown files named by app version:

```text
src/content/release-notes/0.8.4.md
```

The update modal shows the highest bundled release note newer than the
persisted `whats_new_last_seen_version` and not newer than the running app
version.

Tishe: a note can have translations next to it, `0.9.8.ru.md`, `0.9.8.de.md`
and so on (the `src/i18n/locales` folder names). The window shows the one in
the program's language and falls back to `0.9.8.md`, which is English.

Keep these files focused on headline user-facing changes. Release notes support
paragraphs, headings, lists, links, code, quotes, separators, hard line breaks,
and local images under `/release-notes/...`. Raw HTML is ignored before
rendering.

Place image assets in `public/release-notes/{version}/` and reference them from
Markdown with absolute paths:

```md
![Streaming transcription preview](/release-notes/0.9.0/streaming-transcription.webp)
```
