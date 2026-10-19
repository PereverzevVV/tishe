<img src="../src-tauri/icons/128x128.png" width="96" alt="Tishe" />

# Tishe

**Private memory for your conversations.** Dictation and transcription of long recordings, entirely on your own computer: no internet, no account. Built first for Russian, works for English and many other languages.

[Русская версия](README.ru.md) · [Download](https://github.com/PereverzevVV/tishe/releases/latest) · [What's next](#whats-next)

Tishe is pronounced TEE-sheh (Russian for "quieter").

## What it does

- **Transcribes files.** Drop in audio or video of any length — a lecture, an interview, a Zoom call. You get a Word or Markdown document: text by speaker ("Speaker 1", "Speaker 2"), with timestamps, split into parts.
- **Separates speakers** with a built-in model, offline.
- **Edits the text with a built-in language model.** Fixes recognition errors and punctuation, removes "uh" and "um". The model runs on the CPU and is downloaded only if you want it. The raw transcript can be kept next to the edited one.
- **Queues files.** Add several recordings; they are transcribed one after another while you do something else.
- **Dictation** into any app with a hotkey: Word, a browser, a messenger.
- **Your choice of models:** GigaAM v3 for Russian, NVIDIA Parakeet for English and European languages, Qwen3-ASR and Whisper for the rest. The first start asks which language your recordings are in and suggests a model.
- **No cloud.** Audio and text never leave the computer. Cloud services (OpenAI, Groq and others) can be added with your own key, but are off by default.

## Numbers

Measured on a laptop with a Ryzen 5 7530U and 16 GB of RAM, no discrete GPU, Windows 11. One recording per language, one run; WER is the share of wrong words against a hand-made reference, lower is better.

| Recording                  | How                                | Time    | WER   |
| -------------------------- | ---------------------------------- | ------- | ----- |
| Meeting in Russian, 24 min | GigaAM v3, with speaker separation | 2.2 min | 8.9 % |
| same                       | GigaAM v3 + editing by Gemma 4 E2B | 6.7 min | 8.4 % |
| Podcast in English, 8 min  | Parakeet TDT 0.6B v2               | 1.0 min | 1.0 % |

An hour of Russian speech with speakers and editing takes about 17 minutes on this laptop (estimated from the run above). A measurement on a weaker laptop with a GeForce MX150 will come with the next release.

Models on a Russian meeting (28 min, no editing): **GigaAM v3** — WER **7.1 %**, 1.6 min; Parakeet Ultra 0.6B — 11.0 %, 2.2 min. Qwen3-ASR 1.7B on another Russian meeting makes about twice as many errors as GigaAM and is 4 times slower.

Details, method and every run are in [DOCUMENTATION.md](../DOCUMENTATION.md), section 9 (in Russian).

## Install

1. Download `Tishe_…_x64-setup.exe` from the [release page](https://github.com/PereverzevVV/tishe/releases/latest).
2. Run it. The installer is not signed with a paid certificate, so Windows shows a blue "Windows protected your PC" window. Click **More info**, then **Run anyway**.
3. On first start, pick the language of your recordings; Tishe downloads a speech model (0.3 to 1.6 GB).

Requirements: Windows 10 or 11 (64-bit), a CPU with AVX2 (almost all since 2013). Tested with 16 GB of RAM; 8 GB is not tested yet. ffmpeg for reading audio and video is included in the installer.

What Tishe sends over the internet: model downloads only (Hugging Face and the Handy mirror) and, once per start, a question to GitHub about a new version (turn it off in App → Updates). Recordings and text go nowhere unless you connect a cloud service yourself.

## What's next

Tishe is the first part of Private Memory: a private memory of your conversations that lives on your computer. Next versions, in order:

1. **Meeting recording** — your microphone and the other side as two tracks, with text as you talk.
2. **Meeting summaries** — decisions and tasks right after you stop, in the language of the meeting.
3. **Search across meetings** — first by words, then by meaning.
4. **Notes and assistants** — a meeting folder for Obsidian, access for AI assistants over MCP.

No dates: the order may change based on feedback. Star the repo to follow along, and tell me in [Issues](https://github.com/PereverzevVV/tishe/issues) what is missing.

## How it was made

Tishe is based on [Handy](https://github.com/cjpais/Handy), the open-source dictation app by CJ Pais. Dictation, the speech engines and the model manager come from Handy; Tishe adds file transcription, speakers, the built-in language model and its own interface. Thanks to CJ Pais and all Handy contributors.

The code was written with Claude Code. I designed the product, set the tasks, built a bench to compare models on my own reference recordings, and made the decisions from the measurements.

Building from source and how the app works: [DOCUMENTATION.md](../DOCUMENTATION.md), sections 4 and 8 (in Russian). Change history: [CHANGELOG.md](../CHANGELOG.md) (in Russian).

## License

[MIT](../LICENSE), like Handy. The core is free and will stay free; paid extensions may come later. Licenses of third-party libraries and models: [THIRD_PARTY_NOTICES.txt](../src-tauri/licenses/THIRD_PARTY_NOTICES.txt), and in the app under About → Licenses.

## Author

Developed by Viktor Pereverzev, a financial analyst. [GitHub profile](https://github.com/PereverzevVV), email [vvpereverzev@yahoo.com](mailto:vvpereverzev@yahoo.com) for questions and ideas.
