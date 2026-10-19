//! Cut planning. Long recordings are split into equal parts no longer than the
//! requested maximum, with each cut nudged into the quietest nearby moment so a
//! word is not chopped in half. Local models additionally get each part split
//! into short segments, since most of the ONNX engines are built for
//! dictation-length clips rather than half an hour of audio.

use super::media::{PcmFile, SAMPLE_RATE};
use anyhow::Result;

/// Analysis frame for finding pauses (50 ms).
const FRAME: usize = SAMPLE_RATE / 20;
/// How far a part boundary may move to land on a pause.
const PART_SNAP: usize = 10 * SAMPLE_RATE;
/// Segment bounds for local models: 12–25 s by default. Measured on whisper
/// large-v3 as well: 60–120 s segments lost more sentence punctuation than
/// 12–25 s ones. A shorter maximum from the model's ⚙ window shrinks the
/// minimum with it, so 25 s keeps the measured 12 s.
pub fn segment_bounds(max_secs: u32) -> SegmentBounds {
    SegmentBounds {
        min: (max_secs as usize * 12 / 25).max(5) * SAMPLE_RATE,
        max: max_secs as usize * SAMPLE_RATE,
    }
}

#[derive(Clone, Copy)]
pub struct SegmentBounds {
    pub min: usize,
    pub max: usize,
}
/// Segments quieter than this (≈ -50 dBFS) are skipped: feeding pure silence to
/// whisper-family models is the classic trigger for hallucinated captions.
const SILENCE_RMS: f32 = 0.003;

pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    (sum / samples.len() as f64).sqrt() as f32
}

pub fn is_silent(samples: &[f32]) -> bool {
    rms(samples) < SILENCE_RMS
}

/// Index (relative to `samples`) of the middle of the quietest frame.
/// Ties go to the later frame so segments stay as long as allowed.
fn quietest_point(samples: &[f32]) -> usize {
    if samples.len() <= FRAME {
        return samples.len() / 2;
    }
    let mut best = (f32::MAX, samples.len() / 2);
    for (i, frame) in samples.as_chunks::<FRAME>().0.iter().enumerate() {
        let energy = rms(frame);
        if energy <= best.0 {
            best = (energy, i * FRAME + FRAME / 2);
        }
    }
    best.1
}

/// Split `[0, pcm.len())` into equal parts, each at most `max_part` samples,
/// with interior boundaries snapped to a pause within ±`PART_SNAP`.
pub fn plan_parts(pcm: &mut PcmFile, max_part: usize) -> Result<Vec<(usize, usize)>> {
    let total = pcm.len();
    if total <= max_part {
        return Ok(vec![(0, total)]);
    }

    // Leave room for both ends of a part to move by PART_SNAP without the
    // part exceeding the limit.
    let budget = max_part.saturating_sub(2 * PART_SNAP).max(SAMPLE_RATE * 60);
    let count = total.div_ceil(budget);

    let mut bounds = vec![0usize];
    for i in 1..count {
        let nominal = total * i / count;
        let lo = nominal
            .saturating_sub(PART_SNAP)
            .max(*bounds.last().unwrap() + FRAME);
        let hi = (nominal + PART_SNAP).min(total);
        let window = pcm.read(lo, hi)?;
        bounds.push(lo + quietest_point(&window));
    }
    bounds.push(total);

    Ok(bounds.windows(2).map(|w| (w[0], w[1])).collect())
}

/// Split a part's samples into segments of `bounds.min..=bounds.max`,
/// cutting at the quietest point in that window. Offsets are relative to
/// `samples`.
pub fn plan_segments(samples: &[f32], bounds: SegmentBounds) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < samples.len() {
        let remaining = samples.len() - start;
        if remaining <= bounds.max {
            out.push((start, samples.len()));
            break;
        }
        let window = &samples[start + bounds.min..start + bounds.max];
        let cut = start + bounds.min + quietest_point(window);
        out.push((start, cut));
        start = cut;
    }
    out
}

/// Speaker regions shorter than this are folded into a neighbour: a lone
/// "yes" makes a poor clip for the recognizer.
const MIN_REGION: usize = SAMPLE_RATE;

/// Like [`plan_segments`], but no segment crosses a change of speaker, so
/// each segment carries one speaker. `turns` are `(start, end, speaker)`
/// sample ranges relative to `samples`; they may overlap or leave gaps.
/// Gaps are split between their neighbours, and where two people talk at
/// once the longer turn wins.
pub fn plan_segments_with_turns(
    samples: &[f32],
    bounds: SegmentBounds,
    turns: &[(usize, usize, u32)],
) -> Vec<(usize, usize, Option<u32>)> {
    let len = samples.len();
    let mut turns: Vec<(usize, usize, u32)> = turns
        .iter()
        .map(|&(s, e, sp)| (s.min(len), e.min(len), sp))
        .filter(|t| t.1 > t.0)
        .collect();
    if turns.is_empty() {
        return plan_segments(samples, bounds)
            .into_iter()
            .map(|(s, e)| (s, e, None))
            .collect();
    }
    turns.sort_by_key(|t| t.0);

    // Elementary intervals between all turn edges, each given to the longest
    // turn covering it.
    let mut edges: Vec<usize> = turns.iter().flat_map(|t| [t.0, t.1]).collect();
    edges.sort_unstable();
    edges.dedup();
    let mut regions: Vec<(usize, usize, u32)> = Vec::new();
    for w in edges.windows(2) {
        let (a, b) = (w[0], w[1]);
        let owner = turns
            .iter()
            .filter(|t| t.0 <= a && t.1 >= b)
            .max_by_key(|t| t.1 - t.0)
            .map(|t| t.2);
        if let Some(sp) = owner {
            match regions.last_mut() {
                Some(last) if last.2 == sp && last.1 == a => last.1 = b,
                _ => regions.push((a, b, sp)),
            }
        }
    }

    // Close the gaps: the silence before the first turn and after the last
    // one belongs to them, a gap between two turns is cut at its quietest point.
    regions[0].0 = 0;
    let last = regions.len() - 1;
    regions[last].1 = len;
    for i in 1..regions.len() {
        let (gap_start, gap_end) = (regions[i - 1].1, regions[i].0);
        if gap_end > gap_start {
            let cut = gap_start + quietest_point(&samples[gap_start..gap_end]);
            regions[i - 1].1 = cut;
            regions[i].0 = cut;
        }
    }

    // Fold short regions into the longer neighbour, rejoining same-speaker
    // neighbours after each step.
    regions = join_same_speaker(regions);
    while let Some(i) = (0..regions.len())
        .filter(|&i| regions.len() > 1 && regions[i].1 - regions[i].0 < MIN_REGION)
        .min_by_key(|&i| regions[i].1 - regions[i].0)
    {
        let size = |r: &(usize, usize, u32)| r.1 - r.0;
        let into_prev = match (i.checked_sub(1), regions.get(i + 1)) {
            (Some(p), Some(n)) => size(&regions[p]) >= size(n),
            (Some(_), None) => true,
            _ => false,
        };
        let r = regions.remove(i);
        if into_prev {
            regions[i - 1].1 = r.1;
        } else {
            regions[i].0 = r.0;
        }
        regions = join_same_speaker(regions);
    }

    regions
        .into_iter()
        .flat_map(|(a, b, sp)| {
            plan_segments(&samples[a..b], bounds)
                .into_iter()
                .map(move |(s, e)| (a + s, a + e, Some(sp)))
        })
        .collect()
}

/// Merge adjacent regions of the same speaker.
fn join_same_speaker(regions: Vec<(usize, usize, u32)>) -> Vec<(usize, usize, u32)> {
    let mut merged: Vec<(usize, usize, u32)> = Vec::with_capacity(regions.len());
    for r in regions {
        match merged.last_mut() {
            Some(m) if m.2 == r.2 => m.1 = r.1,
            _ => merged.push(r),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default bounds, as the job uses them without a ⚙ change.
    const SEGMENTS: SegmentBounds = SegmentBounds {
        min: 12 * SAMPLE_RATE,
        max: 25 * SAMPLE_RATE,
    };

    #[test]
    fn default_segments_stay_12_to_25_seconds() {
        let b = segment_bounds(crate::model_settings::ASR_SEGMENT_MAX_SECS);
        assert_eq!((b.min, b.max), (SEGMENTS.min, SEGMENTS.max));
        let short = segment_bounds(12);
        assert_eq!((short.min, short.max), (5 * SAMPLE_RATE, 12 * SAMPLE_RATE));
    }

    #[test]
    fn turn_segments_follow_speakers() {
        let samples = tone(SAMPLE_RATE * 100, 0.3);
        let s = |secs: f64| (secs * SAMPLE_RATE as f64) as usize;
        let turns = [
            (s(1.0), s(40.0), 0),
            (s(41.0), s(41.4), 1), // blip: folded into a neighbour
            (s(42.0), s(70.0), 1),
            (s(69.0), s(71.0), 0), // overlap: the longer turn wins
            (s(72.0), s(99.0), 0),
        ];
        let segs = plan_segments_with_turns(&samples, SEGMENTS, &turns);
        assert_eq!(segs.first().unwrap().0, 0);
        assert_eq!(segs.last().unwrap().1, samples.len());
        for w in segs.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        for &(a, b, _) in &segs {
            assert!(b - a <= SEGMENTS.max);
        }
        let speaker_at = |secs: f64| {
            segs.iter()
                .find(|x| x.0 <= s(secs) && s(secs) < x.1)
                .unwrap()
                .2
        };
        assert_eq!(speaker_at(20.0), Some(0));
        assert_eq!(speaker_at(41.2), speaker_at(40.5));
        assert_eq!(speaker_at(60.0), Some(1));
        assert_eq!(speaker_at(69.5), Some(1));
        assert_eq!(speaker_at(90.0), Some(0));
        // The speaker change near 70.x s is a segment boundary.
        assert!(segs.iter().any(|x| x.1 >= s(70.0) && x.1 <= s(72.0)));
    }

    #[test]
    fn no_turns_falls_back_to_plain_segments() {
        let samples = tone(SAMPLE_RATE * 60, 0.3);
        let segs = plan_segments_with_turns(&samples, SEGMENTS, &[]);
        assert_eq!(segs.len(), plan_segments(&samples, SEGMENTS).len());
        assert!(segs.iter().all(|x| x.2.is_none()));
    }

    fn tone(len: usize, amp: f32) -> Vec<f32> {
        (0..len).map(|i| amp * ((i as f32) * 0.1).sin()).collect()
    }

    #[test]
    fn segments_cover_input_and_respect_bounds() {
        let samples = tone(SAMPLE_RATE * 100, 0.3);
        let segs = plan_segments(&samples, SEGMENTS);
        assert_eq!(segs.first().unwrap().0, 0);
        assert_eq!(segs.last().unwrap().1, samples.len());
        for w in segs.windows(2) {
            assert_eq!(w[0].1, w[1].0);
        }
        for &(s, e) in &segs[..segs.len() - 1] {
            assert!(e - s >= SEGMENTS.min && e - s <= SEGMENTS.max);
        }
    }

    #[test]
    fn segments_cut_at_pause() {
        let mut samples = tone(SAMPLE_RATE * 18, 0.3);
        samples.extend(vec![0.0; SAMPLE_RATE / 2]);
        samples.extend(tone(SAMPLE_RATE * 20, 0.3));
        let segs = plan_segments(&samples, SEGMENTS);
        let cut = segs[0].1;
        assert!(cut >= SAMPLE_RATE * 18 && cut <= SAMPLE_RATE * 18 + SAMPLE_RATE / 2);
    }

    #[test]
    fn silence_detection() {
        assert!(is_silent(&vec![0.0; 1000]));
        assert!(!is_silent(&tone(1000, 0.3)));
    }
}
