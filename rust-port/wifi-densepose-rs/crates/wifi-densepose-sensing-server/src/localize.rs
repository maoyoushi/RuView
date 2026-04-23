//! RSSI-based single-person trilateration for the sensing-server broadcast path.
//!
//! This module takes the `NodeInfo` array already published in each sensing
//! update and, when ≥3 nodes have registered world positions and valid RSSI
//! readings, estimates a single person's floor-plane (x, z) coordinates using
//! the log-distance path-loss model followed by linearized least-squares
//! trilateration. The result is written into `PersonDetection.position`
//! (primary person only).
//!
//! Coordinate convention matches the Observatory UI: x/z span the floor in
//! metres, y is height above the floor (left at 0 — the figure renderer
//! handles torso height via keypoints).
//!
//! Intentionally dependency-free: the algorithm is small (~50 lines) and
//! pulling in `wifi-densepose-mat` just for `Triangulator` would bring in
//! an unrelated domain (disaster survivor detection) with its own coordinate
//! and sensor types.

use crate::{NodeInfo, PersonDetection};

/// Reference RSSI (dBm) measured at `REF_DIST` from a node. Indoor 2.4 GHz
/// typical. Can be tuned per deployment — but the log-distance model is
/// already coarse, so "exact" calibration rarely improves things more than a
/// metre anyway.
const REF_RSSI_DBM: f64 = -40.0;
const REF_DIST_M: f64 = 1.0;
/// Path-loss exponent. 2.0 = free space, ~3.0 = typical indoor with
/// obstacles, 4+ = heavy multipath.
const PATH_LOSS_N: f64 = 3.0;

/// Convert RSSI (dBm) to distance (m) via the log-distance path-loss model:
///     RSSI = RSSI_0 - 10 * n * log10(d / d_0)
/// ⇒   d   = d_0 * 10 ^ ((RSSI_0 - RSSI) / (10 * n))
fn rssi_to_distance(rssi_dbm: f64) -> f64 {
    let exp = (REF_RSSI_DBM - rssi_dbm) / (10.0 * PATH_LOSS_N);
    REF_DIST_M * 10.0_f64.powf(exp)
}

/// Linearized least-squares trilateration on the (x, z) floor plane.
///
/// Returns `None` when fewer than 3 nodes have a registered non-zero position
/// and a plausible RSSI reading, or when the linear system degenerates.
///
/// On success returns `[x, 0.0, z]` so it can drop straight into
/// `PersonDetection.position` — y is left for the figure renderer.
pub fn trilaterate_person_xz(nodes: &[NodeInfo]) -> Option<[f64; 3]> {
    let usable: Vec<([f64; 3], f64)> = nodes
        .iter()
        .filter(|n| n.rssi_dbm > -100.0 && n.rssi_dbm < 0.0)
        .filter(|n| {
            // "Registered" = operator configured a non-trivial position.
            n.position[0].abs() + n.position[1].abs() + n.position[2].abs() > 1e-6
        })
        .map(|n| (n.position, rssi_to_distance(n.rssi_dbm)))
        .collect();

    if usable.len() < 3 {
        return None;
    }

    // Use the first node as the reference and subtract out one equation to
    // linearize. Unknown is (x, z); y (node height) is ignored on the
    // assumption nodes and humans are roughly coplanar over 3 m. If that
    // ever stops holding we'd want 3D trilateration.
    let (p0, d0) = usable[0];
    let (x1, z1, r1) = (p0[0], p0[2], d0);
    let m = usable.len() - 1;
    let mut a = vec![[0.0_f64; 2]; m];
    let mut b = vec![0.0_f64; m];
    for (i, (pi, di)) in usable.iter().skip(1).enumerate() {
        let (xi, zi, ri) = (pi[0], pi[2], *di);
        a[i] = [2.0 * (xi - x1), 2.0 * (zi - z1)];
        b[i] = r1 * r1 - ri * ri - x1 * x1 + xi * xi - z1 * z1 + zi * zi;
    }

    // Solve (AᵀA) · s = Aᵀb via 2×2 Cramer's rule.
    let mut ata = [[0.0_f64; 2]; 2];
    let mut atb = [0.0_f64; 2];
    for row in 0..m {
        for i in 0..2 {
            atb[i] += a[row][i] * b[row];
            for j in 0..2 {
                ata[i][j] += a[row][i] * a[row][j];
            }
        }
    }
    let det = ata[0][0] * ata[1][1] - ata[0][1] * ata[1][0];
    if det.abs() < 1e-8 {
        return None;
    }
    let x = (atb[0] * ata[1][1] - atb[1] * ata[0][1]) / det;
    let z = (ata[0][0] * atb[1] - ata[1][0] * atb[0]) / det;
    if !x.is_finite() || !z.is_finite() {
        return None;
    }
    // Guard against the model blowing up on pathological RSSI — 25 m is
    // already well outside any plausible indoor deployment we target.
    if x.abs() > 25.0 || z.abs() > 25.0 {
        return None;
    }

    Some([x, 0.0, z])
}

/// Patch `persons[0].position` with the trilaterated (x, 0, z) if possible.
/// Leaves all other persons untouched — multi-person localization requires
/// per-person link attribution which isn't wired yet.
pub fn apply_trilateration(persons: &mut [PersonDetection], nodes: &[NodeInfo]) {
    if persons.is_empty() {
        return;
    }
    if let Some(xyz) = trilaterate_person_xz(nodes) {
        persons[0].position = xyz;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: u8, pos: [f64; 3], rssi: f64) -> NodeInfo {
        NodeInfo {
            node_id: id,
            rssi_dbm: rssi,
            position: pos,
            amplitude: vec![],
            subcarrier_count: 0,
        }
    }

    #[test]
    fn single_node_returns_none() {
        let nodes = vec![node(1, [0.0, 2.0, 0.0], -50.0)];
        assert!(trilaterate_person_xz(&nodes).is_none());
    }

    #[test]
    fn two_nodes_returns_none() {
        let nodes = vec![
            node(1, [0.0, 2.0, 0.0], -50.0),
            node(2, [5.0, 2.0, 0.0], -55.0),
        ];
        assert!(trilaterate_person_xz(&nodes).is_none());
    }

    #[test]
    fn unregistered_nodes_excluded() {
        // All three at origin → unregistered, should be filtered out.
        let nodes = vec![
            node(1, [0.0, 0.0, 0.0], -50.0),
            node(2, [0.0, 0.0, 0.0], -55.0),
            node(3, [0.0, 0.0, 0.0], -60.0),
        ];
        assert!(trilaterate_person_xz(&nodes).is_none());
    }

    #[test]
    fn three_nodes_recover_known_point() {
        // Place a target at (2.0, 0.0, 1.0) and synthesize the RSSI each
        // node would observe under the log-distance model. The solver
        // should then recover (x, z) close to the target.
        let target = [2.0_f64, 0.0, 1.0];
        let node_positions = [
            [0.0, 2.0, 0.0],
            [6.0, 2.0, 0.0],
            [3.0, 2.0, 5.0],
        ];
        let nodes: Vec<NodeInfo> = node_positions
            .iter()
            .enumerate()
            .map(|(i, p)| {
                let dx = p[0] - target[0];
                let dz = p[2] - target[2];
                let d = (dx * dx + dz * dz).sqrt().max(0.1);
                // Inverse of rssi_to_distance:
                //   RSSI = RSSI_0 - 10 * n * log10(d / d_0)
                let rssi = REF_RSSI_DBM - 10.0 * PATH_LOSS_N * (d / REF_DIST_M).log10();
                node((i + 1) as u8, *p, rssi)
            })
            .collect();

        let est = trilaterate_person_xz(&nodes).expect("trilateration should succeed");
        assert!((est[0] - target[0]).abs() < 0.5, "x err: {} vs {}", est[0], target[0]);
        assert!((est[2] - target[2]).abs() < 0.5, "z err: {} vs {}", est[2], target[2]);
        assert_eq!(est[1], 0.0, "y must be 0 (floor plane)");
    }

    #[test]
    fn apply_trilateration_patches_first_person_only() {
        let nodes = vec![
            node(1, [0.0, 2.0, 0.0], -50.0),
            node(2, [5.0, 2.0, 0.0], -50.0),
            node(3, [2.5, 2.0, 4.0], -50.0),
        ];
        let mut persons = vec![
            PersonDetection {
                id: 1, confidence: 0.5, keypoints: vec![],
                bbox: crate::BoundingBox { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
                zone: "z".into(), position: [0.0, 0.0, 0.0],
            },
            PersonDetection {
                id: 2, confidence: 0.5, keypoints: vec![],
                bbox: crate::BoundingBox { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
                zone: "z".into(), position: [0.0, 0.0, 0.0],
            },
        ];
        apply_trilateration(&mut persons, &nodes);
        // Person 0 should have moved off the origin; person 1 stays untouched.
        assert!(persons[0].position[0].abs() + persons[0].position[2].abs() > 0.0);
        assert_eq!(persons[1].position, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn empty_persons_is_noop() {
        let nodes = vec![
            node(1, [0.0, 2.0, 0.0], -50.0),
            node(2, [5.0, 2.0, 0.0], -50.0),
            node(3, [2.5, 2.0, 4.0], -50.0),
        ];
        let mut persons: Vec<PersonDetection> = vec![];
        apply_trilateration(&mut persons, &nodes); // must not panic
    }
}
