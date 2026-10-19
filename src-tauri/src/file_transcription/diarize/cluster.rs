//! Grouping voice embeddings into speakers.
//!
//! Agglomerative clustering: start with every embedding as its own group and
//! keep merging the two most similar groups (cosine similarity of their summed
//! vectors) until the closest pair is further apart than the threshold, or
//! until the requested number of speakers is reached.

/// Unit-length copy of `v` (zero vectors stay zero).
pub fn normalized(v: &[f32]) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm <= f32::EPSILON {
        return v.to_vec();
    }
    v.iter().map(|x| x / norm).collect()
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// Cluster unit-length `embeddings`. Returns one label per embedding,
/// numbered `0..n_clusters`.
///
/// With `num_clusters` the merging stops at exactly that many groups (or
/// fewer when there are fewer embeddings); otherwise it stops once the most
/// similar pair has a cosine distance above `threshold`.
pub fn agglomerative(
    embeddings: &[Vec<f32>],
    threshold: f32,
    num_clusters: Option<usize>,
) -> Vec<usize> {
    let n = embeddings.len();
    if n == 0 {
        return Vec::new();
    }
    let mut sums: Vec<Vec<f32>> = embeddings.to_vec();
    let mut units: Vec<Vec<f32>> = sums.iter().map(|s| normalized(s)).collect();
    let mut alive = vec![true; n];
    let mut members: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    let mut sim = vec![0f32; n * n];
    for i in 0..n {
        for j in i + 1..n {
            let s = dot(&units[i], &units[j]);
            sim[i * n + j] = s;
            sim[j * n + i] = s;
        }
    }
    // Most similar living neighbour of each living group.
    let best_of = |i: usize, sim: &[f32], alive: &[bool]| -> Option<(usize, f32)> {
        (0..n)
            .filter(|&j| j != i && alive[j])
            .map(|j| (j, sim[i * n + j]))
            .max_by(|a, b| a.1.total_cmp(&b.1))
    };
    let mut best: Vec<Option<(usize, f32)>> = (0..n).map(|i| best_of(i, &sim, &alive)).collect();
    let mut count = n;
    let target = num_clusters.map(|k| k.max(1));

    while count > 1 {
        let Some((i, (j, s))) = (0..n)
            .filter(|&i| alive[i])
            .filter_map(|i| best[i].map(|b| (i, b)))
            .max_by(|a, b| a.1 .1.total_cmp(&b.1 .1))
        else {
            break;
        };
        match target {
            Some(k) if count <= k => break,
            None if 1.0 - s > threshold => break,
            _ => {}
        }
        // Merge j into i.
        let (keep, gone) = (i.min(j), i.max(j));
        let absorbed = std::mem::take(&mut sums[gone]);
        for (s, a) in sums[keep].iter_mut().zip(&absorbed) {
            *s += a;
        }
        units[keep] = normalized(&sums[keep]);
        let moved = std::mem::take(&mut members[gone]);
        members[keep].extend(moved);
        alive[gone] = false;
        count -= 1;
        for other in 0..n {
            if alive[other] && other != keep {
                let s = dot(&units[keep], &units[other]);
                sim[keep * n + other] = s;
                sim[other * n + keep] = s;
            }
        }
        best[keep] = best_of(keep, &sim, &alive);
        best[gone] = None;
        for other in 0..n {
            if !alive[other] || other == keep {
                continue;
            }
            let stale = matches!(best[other], Some((b, _)) if b == keep || b == gone);
            let improved = sim[other * n + keep] > best[other].map_or(f32::MIN, |b| b.1);
            if stale || improved {
                best[other] = best_of(other, &sim, &alive);
            }
        }
    }

    let mut labels = vec![0usize; n];
    for (label, group) in members.iter().filter(|m| !m.is_empty()).enumerate() {
        for &i in group {
            labels[i] = label;
        }
    }
    labels
}

/// Fold groups holding less than `min_share` of all embeddings into the most
/// similar larger group, and renumber. With an unknown speaker count the
/// threshold alone leaves a few seconds-long "extra speakers" (a cough, a
/// laugh, a change of microphone); these are folded back.
pub fn fold_small(embeddings: &[Vec<f32>], labels: &[usize], min_share: f32) -> Vec<usize> {
    let k = labels.iter().copied().max().map_or(0, |m| m + 1);
    let mut sizes = vec![0usize; k];
    for &l in labels {
        sizes[l] += 1;
    }
    let min = ((labels.len() as f32 * min_share).ceil() as usize).max(1);
    let big: Vec<usize> = (0..k).filter(|&c| sizes[c] >= min).collect();
    if big.is_empty() || big.len() == k {
        return labels.to_vec();
    }
    let all = centroids(embeddings, labels);
    let kept: Vec<Vec<f32>> = big.iter().map(|&c| all[c].clone()).collect();
    labels
        .iter()
        .zip(embeddings)
        .map(|(&l, e)| match big.iter().position(|&c| c == l) {
            Some(i) => i,
            None => nearest(&kept, e),
        })
        .collect()
}

/// Summed-and-normalized centroid of each label.
pub fn centroids(embeddings: &[Vec<f32>], labels: &[usize]) -> Vec<Vec<f32>> {
    let k = labels.iter().copied().max().map_or(0, |m| m + 1);
    let dim = embeddings.first().map_or(0, Vec::len);
    let mut sums = vec![vec![0f32; dim]; k];
    for (e, &l) in embeddings.iter().zip(labels) {
        for d in 0..dim {
            sums[l][d] += e[d];
        }
    }
    sums.iter().map(|s| normalized(s)).collect()
}

/// Index of the centroid most similar to `embedding`.
pub fn nearest(centroids: &[Vec<f32>], embedding: &[f32]) -> usize {
    centroids
        .iter()
        .enumerate()
        .map(|(i, c)| (i, dot(c, embedding)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map_or(0, |(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unit vectors scattered tightly around `k` orthogonal directions.
    fn blobs(k: usize, per: usize) -> (Vec<Vec<f32>>, Vec<usize>) {
        let dim = 16;
        let mut out = Vec::new();
        let mut truth = Vec::new();
        for c in 0..k {
            for i in 0..per {
                let mut v = vec![0f32; dim];
                v[c] = 1.0;
                v[(c + 1 + i) % dim] += 0.15;
                v[(c + 5 + 2 * i) % dim] -= 0.1;
                out.push(normalized(&v));
                truth.push(c);
            }
        }
        (out, truth)
    }

    fn same_partition(a: &[usize], b: &[usize]) -> bool {
        (0..a.len()).all(|i| (0..a.len()).all(|j| (a[i] == a[j]) == (b[i] == b[j])))
    }

    #[test]
    fn threshold_finds_the_groups() {
        let (emb, truth) = blobs(3, 6);
        let labels = agglomerative(&emb, 0.5, None);
        assert!(same_partition(&labels, &truth));
    }

    #[test]
    fn requested_count_is_respected() {
        let (emb, _) = blobs(4, 5);
        let labels = agglomerative(&emb, 0.0, Some(2));
        assert_eq!(labels.iter().max(), Some(&1));
        let labels = agglomerative(&emb, 2.0, Some(4));
        assert_eq!(labels.iter().max(), Some(&3));
    }

    #[test]
    fn small_groups_are_folded() {
        let (mut emb, mut labels) = blobs(2, 10);
        // One stray embedding near group 1, labelled as a third group.
        let mut stray = vec![0f32; 16];
        stray[1] = 1.0;
        stray[3] = 0.5;
        emb.push(normalized(&stray));
        labels.push(2);
        let folded = fold_small(&emb, &labels, 0.06);
        assert_eq!(folded.iter().max(), Some(&1));
        assert_eq!(folded[20], 1);
        assert_eq!(&folded[..20], &labels[..20]);
    }

    #[test]
    fn nearest_centroid() {
        let (emb, truth) = blobs(3, 4);
        let c = centroids(&emb, &truth);
        for (e, &t) in emb.iter().zip(&truth) {
            assert_eq!(nearest(&c, e), t);
        }
    }
}
