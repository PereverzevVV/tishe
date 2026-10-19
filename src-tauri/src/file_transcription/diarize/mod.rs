//! Speaker diarization: who spoke when, over the whole recording.
//!
//! The same recipe as pyannote / sherpa-onnx, run through the ONNX Runtime
//! Handy already links (sherpa-onnx itself would bring a second, clashing
//! copy of it):
//!
//! 1. A 10 s window slides over the audio in 2.5 s steps. The pyannote segmentation model
//!    says, for every ~17 ms frame, which of up to three "local" voices in
//!    that window is talking.
//! 2. For each local voice with enough solo speech in the window, a speaker
//!    embedding model turns that speech into a voice fingerprint.
//! 3. The fingerprints of the whole file are clustered; each cluster is one
//!    person, so a speaker keeps the same number from start to end.
//! 4. Frame activity is mapped onto the clusters and turned into turns.
//!
//! It runs over the full extracted file before it is split into parts, so
//! part boundaries never reset speaker numbering.

mod cluster;
pub mod models;

use super::media::{PcmFile, SAMPLE_RATE};
use anyhow::{anyhow, bail, Context, Result};
use ndarray::{Array2, Axis};
use ort::session::Session;
use ort::value::TensorRef;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use transcribe_rs::features::{compute_mel, MelConfig, WindowType};

/// Segmentation window and hop, in samples. pyannote's own hop is 1 s; on
/// mixed lecture recordings 2.5 s gave the same speaker accuracy at 2.7x the
/// speed (DOCUMENTATION.md §5.13).
const WINDOW: usize = 10 * SAMPLE_RATE;
const STEP: usize = WINDOW / 4;
/// pyannote segmentation-3.0 frame geometry, in samples.
const FRAME_SHIFT: usize = 270;
const FRAME_SIZE: usize = 991;
const LOCAL_SPEAKERS: usize = 3;
/// Powerset classes of segmentation-3.0: which local speakers each class means.
const POWERSET: [&[usize]; 7] = [&[], &[0], &[1], &[2], &[0, 1], &[0, 2], &[1, 2]];
/// A local voice needs this much solo speech in a window to get a fingerprint,
/// and at most this much (the middle) is used: fingerprints are most of the
/// running time, and 5 s ones were as accurate as full 10 s windows while
/// 30% faster (DOCUMENTATION.md §5.13).
const MIN_EMBED_SAMPLES: usize = SAMPLE_RATE;
const MAX_EMBED_SAMPLES: usize = 5 * SAMPLE_RATE;
/// Cosine distance at which two voices count as different people, and the
/// share of fingerprints below which an automatically found speaker is
/// folded into the nearest other one. Both tuned on mixed lecture recordings
/// (DOCUMENTATION.md §5.13).
pub const DEFAULT_THRESHOLD: f32 = 0.6;
const MIN_SPEAKER_SHARE: f32 = 0.06;
/// Clustering is quadratic in memory and time, so long files cluster an
/// even sample of fingerprints and the rest join the nearest cluster.
const MAX_CLUSTERED: usize = 2_000;
/// Gaps shorter than this inside one speaker's speech are closed.
const MIN_GAP_SECS: f64 = 0.5;
/// Speech shorter than this is dropped.
const MIN_TURN_SECS: f64 = 0.3;

/// One stretch of a single speaker, in seconds from the start of the file.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub start_secs: f64,
    pub end_secs: f64,
    /// 0-based, numbered in order of first appearance.
    pub speaker: u32,
}

pub struct DiarizeOptions {
    /// Exact number of speakers, when the user knows it.
    pub num_speakers: Option<u32>,
    pub threshold: f32,
}

struct Embedder {
    session: Session,
    input: String,
    mel: MelConfig,
}

impl Embedder {
    fn new(path: &Path) -> Result<Self> {
        let session = transcribe_rs::onnx::session::create_session(path)
            .with_context(|| format!("failed to load {}", path.display()))?;
        let input = session
            .inputs()
            .first()
            .map(|i| i.name().to_string())
            .ok_or_else(|| anyhow!("speaker model has no input"))?;
        // WeSpeaker models want 16-bit sample values, 3D-Speaker ones [-1, 1].
        let normalize =
            transcribe_rs::onnx::session::read_metadata_str(&session, "normalize_samples")?
                .is_none_or(|v| v.trim() != "0");
        let mel = MelConfig {
            sample_rate: SAMPLE_RATE as u32,
            num_mels: 80,
            n_fft: 400,
            hop_length: 160,
            window: WindowType::Hamming,
            f_min: 20.0,
            f_max: None,
            pre_emphasis: Some(0.97),
            snip_edges: true,
            normalize_samples: normalize,
        };
        Ok(Self {
            session,
            input,
            mel,
        })
    }

    /// Unit-length fingerprint of `samples`.
    fn embed(&mut self, samples: &[f32]) -> Result<Vec<f32>> {
        let mut feats: Array2<f32> = compute_mel(samples, &self.mel);
        if feats.nrows() == 0 {
            bail!("too little audio for a voice fingerprint");
        }
        let mean = feats.mean_axis(Axis(0)).unwrap();
        feats -= &mean;
        let input = feats.insert_axis(Axis(0)).into_dyn();
        let outputs = self.session.run(ort::inputs! {
            self.input.as_str() => TensorRef::from_array_view(input.view())?,
        })?;
        let emb = outputs[0].try_extract_array::<f32>()?;
        Ok(cluster::normalized(
            &emb.iter().copied().collect::<Vec<_>>(),
        ))
    }
}

/// Frame activity of one window: `[frames][local speaker]`.
struct Chunk {
    start: usize,
    active: Vec<[bool; LOCAL_SPEAKERS]>,
}

fn segment_window(session: &mut Session, samples: &[f32]) -> Result<Vec<[bool; LOCAL_SPEAKERS]>> {
    let mut x = samples.to_vec();
    x.resize(WINDOW, 0.0);
    let input = ndarray::Array3::from_shape_vec((1, 1, WINDOW), x)?.into_dyn();
    let outputs = session.run(ort::inputs! {
        "x" => TensorRef::from_array_view(input.view())?,
    })?;
    let y = outputs[0].try_extract_array::<f32>()?;
    let y = y
        .into_dimensionality::<ndarray::Ix3>()
        .context("unexpected segmentation output")?;
    Ok(y.index_axis(Axis(0), 0)
        .outer_iter()
        .map(|frame| {
            let class = frame
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map_or(0, |(i, _)| i);
            let mut active = [false; LOCAL_SPEAKERS];
            for &s in POWERSET.get(class).copied().unwrap_or(&[]) {
                active[s] = true;
            }
            active
        })
        .collect())
}

/// Window starts covering `[0, total)`: a hop of `STEP`, plus a final window
/// flush with the end.
fn window_starts(total: usize) -> Vec<usize> {
    if total <= WINDOW {
        return vec![0];
    }
    let mut starts: Vec<usize> = (0..=total - WINDOW).step_by(STEP).collect();
    if starts.last().is_some_and(|&s| s + WINDOW < total) {
        starts.push(total - WINDOW);
    }
    starts
}

/// Run diarization over the whole of `pcm`. `on_progress` gets 0..1.
pub fn diarize(
    pcm: &mut PcmFile,
    segmentation_model: &Path,
    embedding_model: &Path,
    opts: &DiarizeOptions,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(f64),
) -> Result<Vec<Turn>> {
    let mut segmenter = transcribe_rs::onnx::session::create_session(segmentation_model)
        .with_context(|| format!("failed to load {}", segmentation_model.display()))?;
    let mut embedder = Embedder::new(embedding_model)?;

    let total = pcm.len();
    let starts = window_starts(total);
    let mut chunks = Vec::with_capacity(starts.len());
    let mut embeddings = Vec::new();
    // (chunk index, local speaker) of each embedding.
    let mut owners = Vec::new();

    for (ci, &start) in starts.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            bail!(super::CANCELLED);
        }
        on_progress(ci as f64 / starts.len() as f64 * 0.95);
        let samples = pcm.read(start, start + WINDOW)?;
        let active = segment_window(&mut segmenter, &samples)?;
        for speaker in 0..LOCAL_SPEAKERS {
            let solo: Vec<f32> = active
                .iter()
                .enumerate()
                .filter(|(_, a)| a[speaker] && a.iter().filter(|&&x| x).count() == 1)
                .flat_map(|(f, _)| {
                    let a = (f * FRAME_SHIFT).min(samples.len());
                    let b = (a + FRAME_SHIFT).min(samples.len());
                    samples[a..b].iter().copied()
                })
                .collect();
            if solo.len() < MIN_EMBED_SAMPLES {
                continue;
            }
            let skip = solo.len().saturating_sub(MAX_EMBED_SAMPLES) / 2;
            let solo = &solo[skip..(skip + MAX_EMBED_SAMPLES).min(solo.len())];
            embeddings.push(embedder.embed(solo)?);
            owners.push((ci, speaker));
        }
        chunks.push(Chunk { start, active });
    }
    if embeddings.is_empty() {
        on_progress(1.0);
        return Ok(Vec::new());
    }

    let t0 = std::time::Instant::now();
    let labels = cluster_all(&embeddings, opts);
    log::info!(
        "Diarization: {} windows, {} fingerprints, clustering took {:.1}s",
        chunks.len(),
        embeddings.len(),
        t0.elapsed().as_secs_f64()
    );
    let turns = reconstruct(&chunks, &owners, &labels, total);
    on_progress(1.0);
    Ok(turns)
}

/// Cluster every embedding; past `MAX_CLUSTERED`, cluster an even sample and
/// assign the rest to the nearest centroid.
fn cluster_all(embeddings: &[Vec<f32>], opts: &DiarizeOptions) -> Vec<usize> {
    let k = opts.num_speakers.map(|k| k as usize);
    let cluster = |emb: &[Vec<f32>]| speakers(emb, opts.threshold, k);
    if embeddings.len() <= MAX_CLUSTERED {
        return cluster(embeddings);
    }
    let stride = embeddings.len().div_ceil(MAX_CLUSTERED);
    let sample: Vec<Vec<f32>> = embeddings.iter().step_by(stride).cloned().collect();
    let sample_labels = cluster(&sample);
    let centroids = cluster::centroids(&sample, &sample_labels);
    embeddings
        .iter()
        .map(|e| cluster::nearest(&centroids, e))
        .collect()
}

/// Group fingerprints into speakers: by distance threshold, with stray tiny
/// groups folded away, then brought to `k` groups when the count is known.
///
/// Forcing `k` directly in the clustering goes wrong: merging stops at `k`
/// groups, and a stray fragment that is far from everyone survives as a
/// "speaker" while two real voices get merged (seen on a two-person test
/// recording, DOCUMENTATION.md §5.13). So the real groups are found first and
/// only then merged (too many) or the threshold is tightened (too few).
fn speakers(emb: &[Vec<f32>], threshold: f32, k: Option<usize>) -> Vec<usize> {
    let by_threshold = |t: f32| {
        let labels = cluster::agglomerative(emb, t, None);
        cluster::fold_small(emb, &labels, MIN_SPEAKER_SHARE)
    };
    let count = |labels: &[usize]| labels.iter().copied().max().map_or(0, |m| m + 1);
    let mut labels = by_threshold(threshold);
    let Some(k) = k.filter(|&k| k > 0) else {
        return labels;
    };
    // Too few: separate voices more eagerly.
    let mut t = threshold;
    while count(&labels) < k && t > 0.2 {
        t -= 0.05;
        labels = by_threshold(t);
    }
    if count(&labels) <= k {
        return labels;
    }
    // Too many: merge whole groups, most similar first.
    let centroids = cluster::centroids(emb, &labels);
    let merged = cluster::agglomerative(&centroids, f32::MAX, Some(k));
    labels.iter().map(|&l| merged[l]).collect()
}

/// Map local-speaker activity onto the global clusters and build turns.
fn reconstruct(
    chunks: &[Chunk],
    owners: &[(usize, usize)],
    labels: &[usize],
    total_samples: usize,
) -> Vec<Turn> {
    let clusters = labels.iter().copied().max().map_or(0, |m| m + 1);
    let frames = total_samples / FRAME_SHIFT + 1;
    let mut score = vec![0f32; frames * clusters];
    let mut speaking = vec![0f32; frames];
    let mut covered = vec![0f32; frames];
    let mut mapping = std::collections::HashMap::new();
    for (&owner, &label) in owners.iter().zip(labels) {
        mapping.insert(owner, label);
    }

    for (ci, chunk) in chunks.iter().enumerate() {
        let offset = chunk.start / FRAME_SHIFT;
        for (f, active) in chunk.active.iter().enumerate() {
            let g = offset + f;
            if g >= frames {
                break;
            }
            covered[g] += 1.0;
            speaking[g] += active.iter().filter(|&&a| a).count() as f32;
            for (s, &a) in active.iter().enumerate() {
                if let (true, Some(&c)) = (a, mapping.get(&(ci, s))) {
                    score[g * clusters + c] += 1.0;
                }
            }
        }
    }

    // Per frame: how many people talk (averaged over overlapping windows),
    // and which clusters scored highest.
    let mut on = vec![false; frames * clusters];
    for g in 0..frames {
        let n = (speaking[g] / covered[g].max(1.0)).round() as usize;
        if n == 0 {
            continue;
        }
        let row = &score[g * clusters..(g + 1) * clusters];
        let mut order: Vec<usize> = (0..clusters).collect();
        order.sort_by(|&a, &b| row[b].total_cmp(&row[a]));
        for &c in order.iter().take(n) {
            if row[c] > 0.0 {
                on[g * clusters + c] = true;
            }
        }
    }

    let frame_secs = FRAME_SHIFT as f64 / SAMPLE_RATE as f64;
    let center = FRAME_SIZE as f64 / 2.0 / SAMPLE_RATE as f64;
    let end_secs = total_samples as f64 / SAMPLE_RATE as f64;
    let mut raw = Vec::new();
    for c in 0..clusters {
        let mut start = None;
        for g in 0..=frames {
            let active = g < frames && on[g * clusters + c];
            match (active, start) {
                (true, None) => start = Some(g),
                (false, Some(s)) => {
                    raw.push(Turn {
                        start_secs: (s as f64 * frame_secs + center).min(end_secs),
                        end_secs: (g as f64 * frame_secs + center).min(end_secs),
                        speaker: c as u32,
                    });
                    start = None;
                }
                _ => {}
            }
        }
    }
    tidy_turns(raw)
}

/// Close short gaps within a speaker, drop blips, sort, and renumber speakers
/// by first appearance.
fn tidy_turns(mut turns: Vec<Turn>) -> Vec<Turn> {
    turns.sort_by(|a, b| {
        a.speaker
            .cmp(&b.speaker)
            .then(a.start_secs.total_cmp(&b.start_secs))
    });
    let mut merged: Vec<Turn> = Vec::with_capacity(turns.len());
    for t in turns {
        match merged.last_mut() {
            Some(last)
                if last.speaker == t.speaker && t.start_secs - last.end_secs < MIN_GAP_SECS =>
            {
                last.end_secs = last.end_secs.max(t.end_secs);
            }
            _ => merged.push(t),
        }
    }
    merged.retain(|t| t.end_secs - t.start_secs >= MIN_TURN_SECS);
    merged.sort_by(|a, b| a.start_secs.total_cmp(&b.start_secs));
    let mut order = std::collections::HashMap::new();
    for t in &mut merged {
        let next = order.len() as u32;
        t.speaker = *order.entry(t.speaker).or_insert(next);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(a: f64, b: f64, s: u32) -> Turn {
        Turn {
            start_secs: a,
            end_secs: b,
            speaker: s,
        }
    }

    /// Two voices (10 fingerprints each) and one stray fingerprint far from both.
    fn two_voices_and_a_stray() -> Vec<Vec<f32>> {
        let mut out = Vec::new();
        for (axis, other) in [(0usize, 2usize), (1, 3)] {
            for i in 0..10 {
                let mut v = vec![0f32; 8];
                v[axis] = 1.0;
                v[other] = 0.05 * i as f32;
                out.push(cluster::normalized(&v));
            }
        }
        let mut stray = vec![0f32; 8];
        stray[7] = 1.0;
        stray[0] = 0.3;
        out.push(cluster::normalized(&stray));
        out
    }

    #[test]
    fn known_count_keeps_real_voices_apart() {
        let emb = two_voices_and_a_stray();
        for k in [None, Some(2)] {
            let labels = speakers(&emb, DEFAULT_THRESHOLD, k);
            assert_eq!(labels.iter().max(), Some(&1), "k={k:?}");
            assert!(labels[..10].iter().all(|&l| l == labels[0]));
            assert!(labels[10..20].iter().all(|&l| l == labels[10]));
            assert_ne!(labels[0], labels[10]);
        }
        // Asking for more people than are clearly there still splits voices
        // rather than inventing a speaker out of nothing.
        let labels = speakers(&emb, DEFAULT_THRESHOLD, Some(1));
        assert!(labels.iter().all(|&l| l == 0));
    }

    #[test]
    fn windows_cover_the_file() {
        assert_eq!(window_starts(5 * SAMPLE_RATE), vec![0]);
        let total = 25 * SAMPLE_RATE + 123;
        let starts = window_starts(total);
        assert_eq!(starts[0], 0);
        assert_eq!(*starts.last().unwrap() + WINDOW, total);
        assert!(starts.windows(2).all(|w| w[1] - w[0] <= STEP));
    }

    #[test]
    fn tidy_merges_gaps_drops_blips_and_renumbers() {
        let turns = tidy_turns(vec![
            turn(5.0, 8.0, 7),
            turn(0.0, 2.0, 3),
            turn(2.3, 4.0, 3),
            turn(9.0, 9.1, 3),
            turn(10.0, 12.0, 3),
        ]);
        assert_eq!(
            turns,
            vec![turn(0.0, 4.0, 0), turn(5.0, 8.0, 1), turn(10.0, 12.0, 0)]
        );
    }

    /// Diarize a real file and print the turns.
    /// `HANDY_DIAR_MEDIA=<file> HANDY_DIAR_MODELS=<dir with model.onnx and
    /// the embedding model> cargo test --lib diarize_media -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn diarize_media() {
        let media = std::path::PathBuf::from(std::env::var("HANDY_DIAR_MEDIA").expect("media"));
        let dir = std::path::PathBuf::from(std::env::var("HANDY_DIAR_MODELS").expect("models"));
        let emb = std::env::var("HANDY_DIAR_EMBEDDING")
            .unwrap_or_else(|_| "wespeaker_en_voxceleb_resnet34.onnx".into());
        let ffmpeg = super::super::media::find_ffmpeg().unwrap();
        let no_cancel = AtomicBool::new(false);
        let pcm_path = std::env::temp_dir().join("tishe-diar-test.pcm");
        super::super::media::extract_pcm(&ffmpeg, &media, &pcm_path, &no_cancel, |_| {}).unwrap();
        let mut pcm = PcmFile::open(&pcm_path).unwrap();
        let secs = pcm.len() as f64 / SAMPLE_RATE as f64;
        let opts = DiarizeOptions {
            num_speakers: std::env::var("HANDY_DIAR_SPEAKERS")
                .ok()
                .and_then(|s| s.parse().ok()),
            threshold: DEFAULT_THRESHOLD,
        };
        let t0 = std::time::Instant::now();
        let turns = diarize(
            &mut pcm,
            &dir.join("model.onnx"),
            &dir.join(emb),
            &opts,
            &no_cancel,
            |_| {},
        )
        .unwrap();
        let took = t0.elapsed().as_secs_f64();
        println!("audio {secs:.1}s, took {took:.1}s (x{:.3})", took / secs);
        for t in &turns {
            println!(
                "{:8.2} -- {:8.2} speaker_{}",
                t.start_secs, t.end_secs, t.speaker
            );
        }
        let _ = std::fs::remove_file(&pcm_path);
    }
}
