//! The LLM edits a part as numbered lines, one per paragraph ("[12] text"),
//! and answers with the same numbers. Speaker labels and timestamps never go
//! to the model: they come back from our own paragraphs by number, so the
//! model can't lose or invent them, and a line it got wrong falls back to its
//! own text alone instead of the whole chunk.

use super::document::Paragraph;
use super::language;
use std::collections::BTreeMap;
use std::ops::Range;

/// Added to every instruction, built-in or the user's own (text in
/// `prompts/line_rule.txt`, shared with the bench).
pub const LINE_RULE: &str = include_str!("prompts/line_rule.txt");

/// Why a line kept its text instead of the model's edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    /// The answer has no line with this number.
    Missing,
    /// The number came back twice.
    Duplicate,
    /// The line came back empty.
    Empty,
    /// Much longer than the input: the model looped or pulled in the next
    /// line, whose number is then missing.
    TooLong,
    /// Answered in another script: the model translated.
    Translated,
    /// Lost at least `SHRINK_WORDS` words and `SHRINK_SHARE` of them: the
    /// model dropped part of what was said.
    TooShort,
    /// The last line of an answer cut off at the token limit: it ends
    /// mid-word.
    CutOff,
}

/// A line that lost this share of its words and at least `SHRINK_WORDS`
/// keeps its own text. On the bench (DOCUMENTATION §9.3) working models never
/// lost more than 5% of a line; models that dropped sentences lost 27–90%.
const SHRINK_SHARE: f64 = 0.15;
const SHRINK_WORDS: usize = 4;

/// Words for the shrink check: whitespace-separated pieces with a letter or
/// digit, so dashes and stray punctuation don't count.
fn word_count(text: &str) -> usize {
    text.split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count()
}

fn shrunk(input: &str, output: &str) -> bool {
    let (before, after) = (word_count(input), word_count(output));
    before >= after + SHRINK_WORDS && (after as f64) < before as f64 * (1.0 - SHRINK_SHARE)
}

impl Kept {
    pub fn as_str(self) -> &'static str {
        match self {
            Kept::Missing => "missing",
            Kept::Duplicate => "duplicate",
            Kept::Empty => "empty",
            Kept::TooLong => "too long",
            Kept::Translated => "translated",
            Kept::TooShort => "too short",
            Kept::CutOff => "cut off",
        }
    }
}

/// Consecutive paragraph ranges of about `target` characters each.
pub fn chunk_ranges(paragraphs: &[Paragraph], target: usize) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let (mut start, mut size) = (0, 0);
    for (i, p) in paragraphs.iter().enumerate() {
        let len = p.text.chars().count();
        if i > start && size + len > target {
            ranges.push(start..i);
            start = i;
            size = 0;
        }
        size += len;
    }
    if start < paragraphs.len() {
        ranges.push(start..paragraphs.len());
    }
    ranges
}

/// The model's input for one chunk: "[n] text" per paragraph, numbered within
/// the part (1-based).
pub fn render(paragraphs: &[Paragraph], range: Range<usize>) -> String {
    range
        .map(|i| format!("[{}] {}", i + 1, paragraphs[i].text.trim()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Split an answer into numbered lines. "[12] text", "**[12]** text" and
/// "[12]: text" all count; a line without a number continues the previous
/// one. Every text for a number is kept, so duplicates can be spotted.
pub fn parse(answer: &str) -> BTreeMap<usize, Vec<String>> {
    let mut out: BTreeMap<usize, Vec<String>> = BTreeMap::new();
    let mut current: Option<usize> = None;
    for line in answer.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let numbered = line
            .trim_start_matches('*')
            .strip_prefix('[')
            .and_then(|rest| {
                let digits = rest.chars().take_while(char::is_ascii_digit).count();
                let body = rest[digits..].strip_prefix(']')?;
                let n: usize = rest[..digits].parse().ok()?;
                Some((n, body.trim_start_matches(['*', ':']).trim()))
            });
        match numbered {
            Some((n, body)) => {
                out.entry(n).or_default().push(body.to_string());
                current = Some(n);
            }
            None => {
                if let Some(text) = current
                    .and_then(|n| out.get_mut(&n))
                    .and_then(|v| v.last_mut())
                {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    text.push_str(line);
                }
            }
        }
    }
    out
}

/// The edited text of each paragraph in `range`, and the lines that kept
/// their own text with the reason. `cut_off`: the answer stopped at the token
/// limit, so its last line is incomplete.
pub fn merge(
    paragraphs: &[Paragraph],
    range: Range<usize>,
    answer: &BTreeMap<usize, Vec<String>>,
    cut_off: bool,
) -> (Vec<String>, Vec<(usize, Kept)>) {
    let mut texts = Vec::with_capacity(range.len());
    let mut kept = Vec::new();
    let last_answered = answer
        .keys()
        .copied()
        .filter(|n| (range.start + 1..=range.end).contains(n))
        .max();
    for i in range.clone() {
        let input = paragraphs[i].text.trim();
        let verdict = match answer.get(&(i + 1)).map(Vec::as_slice) {
            None | Some([]) => Err(Kept::Missing),
            Some([_, _, ..]) => Err(Kept::Duplicate),
            Some([text]) => {
                let text = text.trim();
                let (inp, out) = (input.chars().count(), text.chars().count());
                // The next line is gone and this one grew by half of it: it
                // was probably pulled in here.
                let swallowed = i + 1 < range.end
                    && !answer.contains_key(&(i + 2))
                    && out >= inp + paragraphs[i + 1].text.trim().chars().count() / 2;
                if text.is_empty() {
                    Err(Kept::Empty)
                } else if out > inp * 3 / 2 + 100 || swallowed {
                    Err(Kept::TooLong)
                } else if cut_off && last_answered == Some(i + 1) {
                    Err(Kept::CutOff)
                } else if language::script_changed(input, text, None) {
                    Err(Kept::Translated)
                } else if shrunk(input, text) {
                    Err(Kept::TooShort)
                } else {
                    Ok(text.to_string())
                }
            }
        };
        match verdict {
            Ok(text) => texts.push(text),
            Err(why) => {
                kept.push((i + 1, why));
                texts.push(input.to_string());
            }
        }
    }
    (texts, kept)
}

/// Digit runs of a text: "3—5 лет, 2022" → ["3", "5", "2022"].
fn numbers(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Put back the input's words where the model lost a number, and only there:
/// "на 3—5 лет" edited to "на три-пять лет" gets "3—5" back, other edits in
/// the line stay. `None` when every number of the input is still in the
/// answer (or only moved). Words are matched by their letters and digits,
/// ignoring case and punctuation.
pub fn keep_numbers(input: &str, output: &str) -> Option<String> {
    let mut lost = numbers(input);
    for n in numbers(output) {
        if let Some(k) = lost.iter().position(|&l| l == n) {
            lost.swap_remove(k);
        }
    }
    if lost.is_empty() {
        return None;
    }
    let (a, b): (Vec<&str>, Vec<&str>) = (
        input.split_whitespace().collect(),
        output.split_whitespace().collect(),
    );
    let key = |w: &str| -> String {
        w.chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect()
    };
    let (ka, kb): (Vec<String>, Vec<String>) = (
        a.iter().map(|w| key(w)).collect(),
        b.iter().map(|w| key(w)).collect(),
    );
    // Longest common subsequence of words; lcs[i][j] is for a[i..], b[j..].
    let mut lcs = vec![vec![0u32; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if ka[i] == kb[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    // Matched word pairs, then a sentinel past both ends.
    let mut pairs = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if ka[i] == kb[j] {
            pairs.push((i, j));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    pairs.push((a.len(), b.len()));
    // Between two matches is a changed stretch: it goes back to the input's
    // words when they hold a lost number its edited words don't.
    let mut out: Vec<&str> = Vec::with_capacity(b.len());
    let (mut from_a, mut from_b, mut restored) = (0, 0, false);
    for (i, j) in pairs {
        let mut here: Vec<&str> = a[from_a..i].iter().flat_map(|w| numbers(w)).collect();
        for n in b[from_b..j].iter().flat_map(|w| numbers(w)) {
            if let Some(k) = here.iter().position(|&h| h == n) {
                here.swap_remove(k);
            }
        }
        if here.iter().any(|n| lost.contains(n)) {
            out.extend(&a[from_a..i]);
            restored = true;
        } else {
            out.extend(&b[from_b..j]);
        }
        if i < a.len() {
            out.push(b[j]);
        }
        (from_a, from_b) = (i + 1, j + 1);
    }
    restored.then(|| out.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn para(text: &str) -> Paragraph {
        Paragraph {
            start_secs: None,
            text: text.into(),
            speaker: None,
        }
    }

    #[test]
    fn chunks_follow_paragraphs() {
        let ps: Vec<Paragraph> = (0..10).map(|_| para(&"a".repeat(100))).collect();
        let ranges = chunk_ranges(&ps, 350);
        assert_eq!(ranges, vec![0..3, 3..6, 6..9, 9..10]);
        assert_eq!(
            render(&ps[..2], 0..2),
            format!("[1] {0}\n[2] {0}", "a".repeat(100))
        );
        assert!(chunk_ranges(&[], 350).is_empty());
    }

    #[test]
    fn answer_lines_by_number() {
        let parsed = parse("[1] Да.\n**[2]** Нет,\nконечно.\n[3]: Вот.\n\n[3] Ещё.");
        assert_eq!(parsed[&1], vec!["Да."]);
        assert_eq!(parsed[&2], vec!["Нет, конечно."]);
        assert_eq!(parsed[&3], vec!["Вот.", "Ещё."]);
    }

    #[test]
    fn bad_lines_keep_their_own_text_alone() {
        let ps = vec![
            para("первое предложение тут"),
            para("второе предложение тут"),
            para("третье"),
            para("четвёртое предложение"),
            para("пятое предложение"),
            para("Practiced it. And you can get better at anything that you practice every day."),
        ];
        let answer = parse(
            "[1] Первое предложение тут.\n\
             [2] Второе предложение тут. Третье.\n\
             [4] Четвёртое.\n[4] Четвёртое ещё раз.\n\
             [5]\n\
             [6] Практикуй это. И ты можешь стать лучше во всём, что практикуешь каждый день.",
        );
        let (texts, kept) = merge(&ps, 0..6, &answer, false);
        assert_eq!(texts[0], "Первое предложение тут.");
        // [2] swallowed [3]: both keep their own text.
        assert_eq!(texts[1], "второе предложение тут");
        assert_eq!(texts[2], "третье");
        assert_eq!(texts[5], ps[5].text);
        assert_eq!(
            kept,
            vec![
                (2, Kept::TooLong),
                (3, Kept::Missing),
                (4, Kept::Duplicate),
                (5, Kept::Empty),
                (6, Kept::Translated),
            ]
        );
    }

    #[test]
    fn a_line_that_lost_words_keeps_its_own_text() {
        let ps = vec![
            para("What I love about what you just said is that oftentimes when you're thinking about habits, you're thinking about the new ones."),
            para("how many, how many hours are under your control"),
            para("да да да да вот так"),
        ];
        // [1] lost a sentence; [2] dropped a repeat (2 words, allowed);
        // [3] lost 4 of 6 words.
        let answer = parse(
            "[1] What I love about what you just said.\n\
             [2] How many hours are under your control?\n\
             [3] Вот так.",
        );
        let (texts, kept) = merge(&ps, 0..3, &answer, false);
        assert_eq!(texts[0], ps[0].text);
        assert_eq!(texts[1], "How many hours are under your control?");
        assert_eq!(texts[2], ps[2].text);
        assert_eq!(kept, vec![(1, Kept::TooShort), (3, Kept::TooShort)]);
    }

    #[test]
    fn the_last_line_of_a_cut_off_answer_keeps_its_own_text() {
        let ps = vec![
            para("первая строка"),
            para("вторая строка"),
            para("третья строка"),
        ];
        let answer = parse("[1] Первая строка.\n[2] Вторая стр");
        let (texts, kept) = merge(&ps, 0..3, &answer, true);
        assert_eq!(
            texts,
            vec!["Первая строка.", "вторая строка", "третья строка"]
        );
        assert_eq!(kept, vec![(2, Kept::CutOff), (3, Kept::Missing)]);
        // Not cut off: the same answer is taken as it is.
        let (texts, _) = merge(&ps, 0..3, &answer, false);
        assert_eq!(texts[1], "Вторая стр");
    }

    #[test]
    fn a_lost_number_comes_back_with_its_words_only() {
        // The whole changed stretch comes back ("там 3—5" became
        // "три-пять"); other edits of the line stay.
        assert_eq!(
            keep_numbers(
                "моделирование на там 3—5 лет вперёд через юнит экономику",
                "Моделирование на три-пять лет вперёд через юнит-экономику."
            )
            .as_deref(),
            Some("Моделирование на там 3—5 лет вперёд через юнит-экономику.")
        );
        // At the end of the line, and a number dropped outright.
        assert_eq!(
            keep_numbers("рост 15 процентов", "Рост процентов.").as_deref(),
            Some("Рост 15 процентов.")
        );
        // Numbers still there, moved, or added: nothing to do.
        assert_eq!(keep_numbers("в 2022 году", "В 2022 году."), None);
        assert_eq!(keep_numbers("5 и 7", "7 и 5"), None);
        assert_eq!(keep_numbers("двадцать второй год", "2022 год"), None);
        assert_eq!(keep_numbers("без чисел", "Без чисел."), None);
        // Only the stretch that lost its "5" goes back, not the one that kept it.
        assert_eq!(
            keep_numbers("5 штуки и ещё 5 рублей", "5 штук и ещё пять рублей.").as_deref(),
            Some("5 штук и ещё 5 рублей.")
        );
    }

    #[test]
    fn numbers_outside_the_chunk_are_ignored() {
        let ps = vec![para("a"), para("b"), para("c")];
        let answer = parse("[2] B\n[3] C\n[9] lost");
        let (texts, kept) = merge(&ps, 1..3, &answer, false);
        assert_eq!(texts, vec!["B", "C"]);
        assert!(kept.is_empty());
    }
}
