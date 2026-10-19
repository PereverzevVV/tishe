//! Language rule sets for the transcript text: which language a part is in,
//! the default LLM instruction for it, filler removal, and fixes for
//! punctuation the recognizer glued to the next word.
//!
//! Russian and English get detailed rules. Any other language gets a
//! conservative fallback that removes nothing and tells the LLM to answer in
//! the language of the text.

use whatlang::{Detector, Lang as WLang};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ru,
    En,
    /// Anything else, with its English name ("German") when detected, or too
    /// little text to tell (`None`).
    Other(Option<&'static str>),
}

impl Lang {
    /// For the notes section: "ru", "en", or the language's English name.
    pub fn code(self) -> &'static str {
        match self {
            Lang::Ru => "ru",
            Lang::En => "en",
            Lang::Other(name) => name.unwrap_or("other"),
        }
    }
}

/// The language a part's text is in, read from the text itself: the speech
/// language setting is often "ru" while an English-only model transcribes an
/// English file. Too little text to judge falls back to `hint`.
pub fn detect(text: &str, hint: Option<&str>) -> Lang {
    let from_hint = || match hint.map(|h| h.trim().to_lowercase()) {
        Some(h) if h.starts_with("ru") => Lang::Ru,
        Some(h) if h.starts_with("en") => Lang::En,
        _ => Lang::Other(None),
    };
    if text.chars().filter(|c| c.is_alphabetic()).count() < 40 {
        return from_hint();
    }
    match Detector::new().detect(text) {
        Some(info) if info.is_reliable() => match info.lang() {
            WLang::Rus => Lang::Ru,
            WLang::Eng => Lang::En,
            other => Lang::Other(Some(other.eng_name())),
        },
        _ => from_hint(),
    }
}

/// The built-in LLM instructions, in `prompts/` so the bench reads the same
/// text (see `prompts/README.md`).
const PROMPT_RU: &str = include_str!("prompts/ru.txt");
/// Added to the Russian instruction for the models listed in
/// `CAREFUL_MODELS` (bench 2026-10-06, DOCUMENTATION §9.4).
const RU_CAREFUL_RULE: &str = include_str!("prompts/ru_careful_rule.txt");
/// Local models that get `RU_CAREFUL_RULE`: with it Gemma 4 E4B made 3.7
/// times fewer new errors for 8% fewer fixes. Gemma E2B stopped editing and
/// Qwen 4B lost a third of its fixes with it, so they keep the plain one.
const CAREFUL_MODELS: &[&str] = &["gemma-4-e4b", "gemma-4-e4b-qat"];
const PROMPT_EN: &str = include_str!("prompts/en.txt");
const PROMPT_UNIVERSAL: &str = include_str!("prompts/universal.txt");

/// The built-in LLM instruction for the text's language. Russian and English
/// are the instructions the app shipped before, minus "split into
/// paragraphs": paragraphs are now ours, sent as numbered lines
/// (`numbered::LINE_RULE`). Other languages get the English universal one
/// with the language named. Wording changes go through the bench first: on
/// the reference chunk repeats of one prompt differ as much as two prompts do
/// (DOCUMENTATION §5.15). Translation is also caught in code
/// (`script_changed`).
pub fn default_prompt(lang: Lang) -> String {
    match lang {
        Lang::Ru => PROMPT_RU.trim().to_string(),
        Lang::En => PROMPT_EN.trim().to_string(),
        Lang::Other(name) => universal_prompt(name.unwrap_or("its original language")),
    }
}

/// The built-in instruction for `lang` and the local model `model_id` (empty
/// for cloud providers): `default_prompt`, plus the careful rule for Russian
/// with the models in `CAREFUL_MODELS`.
pub fn default_prompt_for(lang: Lang, model_id: &str) -> String {
    let base = default_prompt(lang);
    if lang == Lang::Ru && CAREFUL_MODELS.contains(&model_id) {
        format!("{base}\n\n{}", RU_CAREFUL_RULE.trim())
    } else {
        base
    }
}

/// The universal (English-language) instruction for text in `language`.
pub fn universal_prompt(language: &str) -> String {
    PROMPT_UNIVERSAL.trim().replace("{language}", language)
}

/// Whether a word is a hesitation sound: never a real word in that language,
/// so removing it cannot change what was said. `prev` is the word before it.
fn is_filler(tok: &Token, prev: Option<&str>, lang: Lang) -> bool {
    let core = tok.core;
    // A cut-off sound left as a bare hyphen before a comma: "В том числе, -,
    // также". A bare "-" without the comma is a dash and stays.
    if core == "-" {
        return tok.trail.starts_with(',');
    }
    // Letters only: "э-э-э" → "эээ", "Mm-hmm" → "mmhmm".
    let letters: String = core.to_lowercase().chars().filter(|&c| c != '-').collect();
    let len = letters.chars().count();
    if len == 0 {
        return false;
    }
    let all = |set: &[char]| letters.chars().all(|c| set.contains(&c));
    let prefix_then = |p: &str, rest: char| {
        letters
            .strip_prefix(p)
            .is_some_and(|r| r.chars().all(|c| c == rest))
    };
    match lang {
        // э, ээ, э-э-э, а-а, аа, а-э; мм, м-м, хм, хмм, гм, эм. Never a single
        // «а» (a conjunction) or «ах»/«ох» (interjections with meaning).
        //
        // Also: a stretched «и» that isn't followed by its sentence ("и-и-и
        // Хорошо", "и-ии."; see `shorten_stretched_i`), a cut-off «-а», and a
        // lone «м,» — but not «5 м,» (metres).
        Lang::Ru => {
            (all(&['э', 'а']) && (letters.contains('э') || len >= 2))
                || (all(&['м']) && len >= 2)
                || is_stretched_i(core)
                || (core.starts_with('-') && all(&['а']))
                || (core == "м"
                    && tok.trail.starts_with(',')
                    && !prev.is_some_and(|p| p.ends_with(|c: char| c.is_ascii_digit())))
                || prefix_then("хм", 'м')
                || prefix_then("гм", 'м')
                || prefix_then("эм", 'м')
        }
        // uh, uhh, um, umm, uhm, erm, er, hm, hmm, mmm. Not "ah"/"oh", not
        // "mm-hmm" (it means yes), not "like" or "you know".
        Lang::En => {
            prefix_then("uh", 'h')
                || prefix_then("um", 'm')
                || prefix_then("uhm", 'm')
                || prefix_then("erm", 'm')
                || letters == "er"
                || prefix_then("hm", 'm')
                || (all(&['m']) && len >= 3)
        }
        Lang::Other(_) => false,
    }
}

const SENTENCE_END: [char; 4] = ['.', '!', '?', '…'];

/// Remove hesitation sounds ("э-э", "а-а", "хмм"; "uh", "um", "hmm") and tidy
/// the punctuation around them. Real words — «а», «ну», «вот»; "like",
/// "you know" — are never touched. Other languages pass through unchanged.
pub fn remove_fillers(text: &str, lang: Lang) -> String {
    if matches!(lang, Lang::Other(_)) {
        return text.to_string();
    }
    let owned: Vec<String> = text.split_whitespace().map(str::to_string).collect();
    let owned = if lang == Lang::Ru {
        shorten_stretched_i(&unglue_fillers(owned))
    } else {
        owned
    };
    let tokens: Vec<&str> = owned.iter().map(String::as_str).collect();
    let mut out: Vec<String> = Vec::with_capacity(tokens.len());
    // Leading punctuation of a removed filler ("—", "«") moves to the next word.
    let mut carry_lead = String::new();
    let mut capitalize_next = false;
    for (i, raw) in tokens.iter().enumerate() {
        let tok = split_token(raw);
        let prev = i.checked_sub(1).map(|p| tokens[p]);
        if !is_filler(&tok, prev, lang) {
            let mut word = format!("{carry_lead}{raw}");
            carry_lead.clear();
            if capitalize_next {
                word = capitalize_first(&word);
                capitalize_next = false;
            }
            out.push(word);
            continue;
        }
        carry_lead.push_str(tok.lead);
        let at_sentence_start = out
            .last()
            .is_none_or(|p| p.ends_with(SENTENCE_END) || p.ends_with(':'));
        let starts_upper = tok.core.chars().next().is_some_and(char::is_uppercase);
        if at_sentence_start && starts_upper {
            capitalize_next = true;
        }
        // A sentence end on the filler belongs to the word before it, when the
        // next word opens a sentence ("так, э-э. Теперь" → "так. Теперь").
        if let Some(end) = tok.trail.chars().find(|c| SENTENCE_END.contains(c)) {
            let next_opens = tokens[i + 1..]
                .iter()
                .zip(&tokens[i..])
                .map(|(t, p)| (split_token(t), *p))
                .find(|(t, p)| !is_filler(t, Some(p), lang))
                .map(|(t, _)| t)
                .and_then(|t| t.core.chars().next())
                .is_none_or(char::is_uppercase);
            if let Some(prev) = out.last_mut() {
                if next_opens && !prev.ends_with(SENTENCE_END) {
                    let trimmed = prev.trim_end_matches([',', ';', ':', '—', '-']).to_string();
                    *prev = format!("{trimmed}{end}");
                }
            }
        }
    }
    let mut s = out.join(" ");
    if !carry_lead.is_empty() {
        s.push_str(&carry_lead);
    }
    s.trim_start_matches([',', ';', ' ']).to_string()
}

/// «и-и-и», «И-и», «и-ии»: a stretched «и». Needs a hyphen — «ИИ» is
/// "искусственный интеллект".
fn is_stretched_i(core: &str) -> bool {
    core.contains('-')
        && core.chars().filter(|&c| c != '-').count() >= 2
        && core.chars().all(|c| matches!(c, 'и' | 'И' | '-'))
}

/// A stretched «и» that goes on into its sentence is the word «и», said
/// slowly: «свой, и-и-и понять» → «свой, и понять». Before a capital letter or
/// with a sentence end on it, it's a hesitation and `is_filler` drops it.
fn shorten_stretched_i(tokens: &[String]) -> Vec<String> {
    tokens
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let tok = split_token(raw);
            let next_lower = tokens
                .get(i + 1)
                .and_then(|n| n.chars().find(|c| c.is_alphabetic()))
                .is_some_and(char::is_lowercase);
            if is_stretched_i(tok.core) && tok.trail.is_empty() && next_lower {
                let i_word = if tok.core.starts_with('И') {
                    "И"
                } else {
                    "и"
                };
                format!("{}{i_word}", tok.lead)
            } else {
                raw.clone()
            }
        })
        .collect()
}

/// A hesitation glued to the word before it: «чтоэээ» → «что»,
/// «заниматьсямм» → «заниматься». The word left must be 3+ Russian letters.
/// «мм» is cut only from a lowercase word and after a letter real words never
/// put before it: «грамм», «программ», «сумм», «дилемм» end in «амм», «умм»,
/// «емм»; «Гримм» is a name.
fn unglue_fillers(tokens: Vec<String>) -> Vec<String> {
    let glued_stem = |core: &str| -> Option<usize> {
        let chars: Vec<char> = core.chars().collect();
        let run = |c: char| chars.iter().rev().take_while(|&&x| x == c).count();
        let stem_len = if run('э') >= 2 {
            chars.len() - run('э')
        } else if run('м') >= 2 {
            let n = chars.len() - run('м');
            let before = chars.get(n.checked_sub(1)?)?;
            if matches!(before, 'а' | 'у' | 'е') || chars[0].is_uppercase() {
                return None;
            }
            n
        } else {
            return None;
        };
        let stem = &chars[..stem_len];
        let russian = |c: &char| matches!(c.to_lowercase().next(), Some('а'..='я' | 'ё'));
        (stem.len() >= 3 && stem.iter().all(russian)).then_some(stem_len)
    };
    tokens
        .into_iter()
        .map(|raw| {
            let tok = split_token(&raw);
            match glued_stem(tok.core) {
                Some(n) => {
                    let stem: String = tok.core.chars().take(n).collect();
                    format!("{}{stem}{}", tok.lead, tok.trail)
                }
                None => raw,
            }
        })
        .collect()
}

struct Token<'a> {
    lead: &'a str,
    core: &'a str,
    trail: &'a str,
}

/// Split "«э-э," into lead "«", core "э-э", trail ",". Inner hyphens stay in
/// the core; a lone trailing or leading hyphen ("э-", "-а") does too.
fn split_token(t: &str) -> Token<'_> {
    let is_punct = |c: char| !c.is_alphanumeric() && c != '-';
    let start = t.find(|c: char| !is_punct(c)).unwrap_or(t.len());
    let end = t
        .char_indices()
        .rev()
        .find(|&(_, c)| !is_punct(c))
        .map_or(start, |(i, c)| i + c.len_utf8());
    Token {
        lead: &t[..start],
        core: &t[start..end.max(start)],
        trail: &t[end.max(start)..],
    }
}

fn capitalize_first(word: &str) -> String {
    let mut done = false;
    word.chars()
        .map(|c| {
            if !done && c.is_alphabetic() {
                done = true;
                c.to_uppercase().next().unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

/// Put back the space the recognizer dropped after punctuation: a comma
/// between two letters ("смысле,в" → "смысле, в"; numbers like "3,5" stay),
/// and a sentence mark between two lowercase Cyrillic letters ("хорошо.а" →
/// "хорошо. а"). Latin text keeps "site.com", "e.g." as they are.
pub fn fix_glued_punctuation(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        out.push(c);
        let (Some(&prev), Some(&next)) = (
            i.checked_sub(1).and_then(|p| chars.get(p)),
            chars.get(i + 1),
        ) else {
            continue;
        };
        let cyr_lower = |ch: char| matches!(ch, 'а'..='я' | 'ё');
        let glued_comma = c == ',' && prev.is_alphabetic() && next.is_alphabetic();
        let glued_end = matches!(c, '.' | '!' | '?') && cyr_lower(prev) && cyr_lower(next);
        if glued_comma || glued_end {
            out.push(' ');
        }
    }
    out
}

/// Share of Cyrillic among the letters, when there are enough to tell.
fn cyrillic_share(text: &str) -> Option<f64> {
    let (mut cyr, mut all) = (0usize, 0usize);
    for c in text.chars().filter(|c| c.is_alphabetic()) {
        all += 1;
        if matches!(c, 'а'..='я' | 'А'..='Я' | 'ё' | 'Ё') {
            cyr += 1;
        }
    }
    (all >= 40).then(|| cyr as f64 / all as f64)
}

/// Whether the LLM answered in another script than the text it was given —
/// it translated. Speaker labels are in the app's language, so they don't
/// count.
pub fn script_changed(input: &str, output: &str, speaker_label: Option<&str>) -> bool {
    let strip = |t: &str| match speaker_label {
        Some(l) if !l.is_empty() => t.replace(l, ""),
        _ => t.to_string(),
    };
    match (
        cyrillic_share(&strip(input)),
        cyrillic_share(&strip(output)),
    ) {
        (Some(a), Some(b)) => (a - b).abs() > 0.4,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_language_from_text_not_setting() {
        let en = "What I love about what you just said is that oftentimes when you're thinking about habits, you're thinking about the new ones.";
        assert_eq!(detect(en, Some("ru")), Lang::En);
        let ru = "Собственно, мы ищем сейчас человека в направлении в департамент корпоративных финансов. Два бакета задач.";
        assert_eq!(detect(ru, Some("en")), Lang::Ru);
        assert_eq!(detect("Да.", Some("ru")), Lang::Ru);
        assert_eq!(detect("Да.", None), Lang::Other(None));
        let de = "Was mir an dem gefällt, was du gerade gesagt hast, ist, dass man oft an neue Gewohnheiten denkt.";
        assert_eq!(detect(de, Some("ru")), Lang::Other(Some("German")));
    }

    #[test]
    fn russian_fillers_go_real_words_stay() {
        let t = "Э-э-э, первый актив — это онлайн-кинотеатр. А-а, и пятое — это лейбл. Вот, э-э, создание студии. А мы, ну, работаем. Хмм, окей.";
        assert_eq!(
            remove_fillers(t, Lang::Ru),
            "Первый актив — это онлайн-кинотеатр. И пятое — это лейбл. Вот, создание студии. А мы, ну, работаем. Окей."
        );
        assert_eq!(
            remove_fillers("Мы расшиваем, э-ээ. P&L на юниты, ммм, и всё.", Lang::Ru),
            "Мы расшиваем. P&L на юниты, и всё."
        );
        assert_eq!(
            remove_fillers("так, э-э и дальше", Lang::Ru),
            "так, и дальше"
        );
        assert_eq!(
            remove_fillers("Это аа важно, эм, да", Lang::Ru),
            "Это важно, да"
        );
        // «а» and «ах» are words.
        assert_eq!(remove_fillers("А ах, а вот", Lang::Ru), "А ах, а вот");
    }

    /// Cases found in the GigaAM transcript of the reference interview.
    #[test]
    fn russian_stretched_glued_and_cut_off_fillers() {
        // A stretched «и» going on into its sentence is the word «и».
        assert_eq!(
            remove_fillers("он свой, и-и-и понять. И-и-и в такой ситуации", Lang::Ru),
            "он свой, и понять. И в такой ситуации"
        );
        // Before a capital or with a sentence end on it, it's a hesitation.
        assert_eq!(
            remove_fillers("Угу. Да. м, значит, и-и-и Хорошо, и всё-таки", Lang::Ru),
            "Угу. Да. значит, Хорошо, и всё-таки"
        );
        assert_eq!(
            remove_fillers("затронута компания? -а, и-ии. Насколько", Lang::Ru),
            "затронута компания? Насколько"
        );
        // «ИИ» is artificial intelligence, «ии» without a hyphen too.
        assert_eq!(
            remove_fillers("студии ИИ и ии-студии", Lang::Ru),
            "студии ИИ и ии-студии"
        );
        // Cut-off sounds; a bare dash stays.
        assert_eq!(
            remove_fillers(
                "В том числе, -, также. Модели. -а, просто. Актив - это",
                Lang::Ru
            ),
            "В том числе, также. Модели. просто. Актив - это"
        );
        // Glued hesitations.
        assert_eq!(
            remove_fillers("заниматьсямм тем, потому чтоэээ. Как минимум", Lang::Ru),
            "заниматься тем, потому что. Как минимум"
        );
        // Real words ending in «мм», metres, «Гримм» stay.
        assert_eq!(
            remove_fillers(
                "сто грамм, программ, сумм, дилемм, братья Гримм, 5 м, а",
                Lang::Ru
            ),
            "сто грамм, программ, сумм, дилемм, братья Гримм, 5 м, а"
        );
    }

    #[test]
    fn english_fillers_go_real_words_stay() {
        assert_eq!(
            remove_fillers(
                "Um, so I was, uh, like, you know, thinking. Hmm. Mm-hmm, yes.",
                Lang::En
            ),
            "So I was, like, you know, thinking. Mm-hmm, yes."
        );
        assert_eq!(remove_fillers("er I mean um", Lang::En), "I mean");
        // The defaults are the shipped instructions without the paragraph clause.
        assert_eq!(default_prompt(Lang::Ru), "Ты — редактор расшифровок устной речи. Тебе дан фрагмент автоматической расшифровки аудиозаписи. Исправь ошибки распознавания, орфографию и пунктуацию. Ничего не сокращай, не пересказывай и не добавляй от себя — сохрани всё сказанное дословно. Верни только исправленный текст, без комментариев.");
        assert_eq!(
            default_prompt(Lang::Other(Some("German"))),
            universal_prompt("German")
        );
        assert!(universal_prompt("German").contains("Write your answer in German"));
        assert_eq!(default_prompt(Lang::En), "You are an editor of speech transcripts. You receive a fragment of an automatic transcript of an audio recording. Fix recognition errors, spelling and punctuation. Do not shorten, summarize or add anything — keep everything that was said, word for word. Reply with the corrected text only, without comments.");
        assert_eq!(remove_fillers("э-э, uh", Lang::Other(None)), "э-э, uh");
    }

    #[test]
    fn careful_rule_only_for_gemma_e4b_in_russian() {
        let plain = default_prompt(Lang::Ru);
        let careful = default_prompt_for(Lang::Ru, "gemma-4-e4b-qat");
        assert!(careful.starts_with(&plain));
        assert!(careful.ends_with("Числа оставляй цифрами."));
        assert_eq!(default_prompt_for(Lang::Ru, "gemma-4-e4b"), careful);
        assert_eq!(default_prompt_for(Lang::Ru, "gemma-4-e2b-qat"), plain);
        assert_eq!(default_prompt_for(Lang::Ru, ""), plain);
        assert_eq!(
            default_prompt_for(Lang::En, "gemma-4-e4b-qat"),
            default_prompt(Lang::En)
        );
    }

    #[test]
    fn glued_punctuation_gets_its_space() {
        assert_eq!(
            fix_glued_punctuation("хорошо.а в смысле,в 3,5% site.com Яндекс.Карты"),
            "хорошо. а в смысле, в 3,5% site.com Яндекс.Карты"
        );
    }

    /// Tool for the LLM bench, not a check: cleans a raw TSV (n, start,
    /// speaker, text) the way a job does before the LLM, to make a bench case
    /// from a transcript without a debug folder.
    /// HANDY_CLEAN_IN=raw.tsv HANDY_CLEAN_OUT=input.tsv cargo test --lib clean_tsv_for_bench -- --ignored
    #[test]
    #[ignore]
    fn clean_tsv_for_bench() {
        let input = std::env::var("HANDY_CLEAN_IN").expect("HANDY_CLEAN_IN");
        let output = std::env::var("HANDY_CLEAN_OUT").expect("HANDY_CLEAN_OUT");
        let raw = std::fs::read_to_string(input).unwrap();
        let rows: Vec<Vec<&str>> = raw
            .lines()
            .skip(1)
            .map(|l| l.splitn(4, '\t').collect::<Vec<_>>())
            .filter(|r| r.len() == 4)
            .collect();
        let all: String = rows.iter().map(|r| r[3]).collect::<Vec<_>>().join(" ");
        let lang = detect(&all, None);
        let mut out = String::from("n\tstart\tspeaker\ttext\n");
        for r in &rows {
            let text = remove_fillers(&fix_glued_punctuation(r[3]), lang);
            out.push_str(&format!("{}\t{}\t{}\t{}\n", r[0], r[1], r[2], text));
        }
        std::fs::write(output, out).unwrap();
    }

    #[test]
    fn translation_is_detected() {
        let en = "Спикер 1: Practiced it. And you can get better at anything that you practice. I think it's interesting.";
        let ru = "Спикер 1: Практикуй это. И ты можешь стать лучше во всём, что практикуешь. Я думаю, это интересно.";
        assert!(script_changed(en, ru, Some("Спикер")));
        assert!(!script_changed(en, en, Some("Спикер")));
        assert!(!script_changed(ru, ru, Some("Спикер")));
    }
}
