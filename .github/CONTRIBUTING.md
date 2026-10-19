# Участие в Tishe / Contributing to Tishe

Tishe — форк [Handy](https://github.com/cjpais/Handy) от CJ Pais. Корневые `README.md`, `CONTRIBUTING.md`, `BUILD.md` и `CONTRIBUTING_TRANSLATIONS.md` пришли из Handy и описывают Handy; для Tishe главные документы — [DOCUMENTATION.md](../DOCUMENTATION.md) (по-русски) и [CHANGELOG.md](../CHANGELOG.md).

Tishe is a fork of [Handy](https://github.com/cjpais/Handy). The root `README.md`, `CONTRIBUTING.md`, `BUILD.md` and `CONTRIBUTING_TRANSLATIONS.md` come from Handy and describe Handy; Tishe's own docs are [DOCUMENTATION.md](../DOCUMENTATION.md) (in Russian) and [CHANGELOG.md](../CHANGELOG.md).

## Ошибки и идеи / Bugs and ideas

- Ошибки — в [Issues](https://github.com/PereverzevVV/tishe/issues), по шаблону: версия, компьютер, шаги, файл журнала («О программе» → «Папки» → «Папка журналов»).
- Не прикладывайте записи с личными разговорами.
- Ошибки, которые есть и в самом Handy (диктовка, горячие клавиши, движки распознавания), лучше сообщать в Handy: Tishe регулярно вливает его исправления.

Bugs go to [Issues](https://github.com/PereverzevVV/tishe/issues). Bugs that also happen in Handy itself are best reported to Handy; Tishe merges its fixes regularly.

## Код / Code

- Сборка — DOCUMENTATION, раздел 8 (Windows: Rust, Bun, CMake, Vulkan SDK, `scripts/fetch-llama.ps1`, `scripts/fetch-ffmpeg.ps1`).
- Код Tishe живёт в своих модулях (`src-tauri/src/file_transcription/`, `local_llm.rs`, `src/components/pages/` и др.); в файлах Handy — только тонкие вставки, чтобы обновления Handy вливались без конфликтов. Список изменённых файлов Handy — DOCUMENTATION §6.
- Одно изменение — один pull request. Изменение поведения обновляет `CHANGELOG.md` и нужные разделы `DOCUMENTATION.md`.
- Перед отправкой: `bun run lint`, `bunx tsc --noEmit`, `bun run check:translations`, `cargo fmt --check`, `cargo test --lib`.

Build: DOCUMENTATION section 8. Keep Tishe code in its own modules and edits to Handy files thin. One change per pull request; update the changelog and docs with it.

## Лицензия / License

Присылая изменения, вы соглашаетесь, что они распространяются под [MIT](../LICENSE).
By contributing you agree that your changes are licensed under [MIT](../LICENSE).
