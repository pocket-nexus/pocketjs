//! Minimal GLB container parsing plus just enough glTF to serve VRM/VRMA:
//! chunk-0 JSON via serde_json, chunk-1 BIN as a borrowed slice, float32
//! accessor decoding, and the rest-pose node hierarchy. No full importer.

use anyhow::{Context, Result, bail, ensure};
use glam::{Mat4, Quat, Vec3};
use pocket3d::anim::{NodeTrs, Skeleton};
use serde::Deserialize;
use serde_json::Value;

const CHUNK_JSON: u32 = 0x4E4F_534A; // "JSON"
const CHUNK_BIN: u32 = 0x004E_4942; // "BIN\0"

/// A parsed GLB container: the chunk-0 JSON document plus the BIN payload.
#[derive(Debug)]
pub struct Glb<'a> {
    pub json: Value,
    /// Chunk-1 (BIN) payload; empty when the container carries no BIN chunk.
    pub bin: &'a [u8],
}

fn read_u32(bytes: &[u8], off: usize) -> Result<u32> {
    let end = off.checked_add(4).context("GLB offset overflow")?;
    ensure!(end <= bytes.len(), "GLB truncated at byte {off}");
    Ok(u32::from_le_bytes(bytes[off..end].try_into().unwrap()))
}

/// Parse a GLB container (magic `glTF`, version 2). Unknown chunks are
/// skipped per spec; the first JSON and first BIN chunk win.
pub fn parse_glb(bytes: &[u8]) -> Result<Glb<'_>> {
    ensure!(bytes.len() >= 12, "GLB too short ({} bytes)", bytes.len());
    ensure!(&bytes[0..4] == b"glTF", "not a GLB: bad magic");
    let version = read_u32(bytes, 4)?;
    ensure!(version == 2, "unsupported GLB version {version}");

    let mut off = 12;
    let mut json: Option<&[u8]> = None;
    let mut bin: Option<&[u8]> = None;
    while off < bytes.len() {
        let len = read_u32(bytes, off)? as usize;
        let kind = read_u32(bytes, off + 4)?;
        let start = off + 8;
        let end = start
            .checked_add(len)
            .context("GLB chunk length overflow")?;
        ensure!(end <= bytes.len(), "GLB chunk overruns file");
        match kind {
            CHUNK_JSON if json.is_none() => json = Some(&bytes[start..end]),
            CHUNK_BIN if bin.is_none() => bin = Some(&bytes[start..end]),
            _ => {}
        }
        off = end;
    }
    let json = json.context("GLB has no JSON chunk")?;
    let json = serde_json::from_slice(json).context("GLB JSON chunk is not valid JSON")?;
    Ok(Glb {
        json,
        bin: bin.unwrap_or(&[]),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Accessor {
    buffer_view: Option<usize>,
    #[serde(default)]
    byte_offset: usize,
    component_type: u32,
    count: usize,
    #[serde(rename = "type")]
    kind: String,
    sparse: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BufferView {
    #[serde(default)]
    buffer: usize,
    #[serde(default)]
    byte_offset: usize,
    byte_length: usize,
    byte_stride: Option<usize>,
}

/// Decode float32 accessor `index` from the BIN chunk into a flat Vec,
/// returning the values and the component count per element (SCALAR=1 …
/// VEC4=4). Sparse accessors and non-float component types are rejected.
pub fn read_f32_accessor(json: &Value, bin: &[u8], index: usize) -> Result<(Vec<f32>, usize)> {
    let acc = json
        .get("accessors")
        .and_then(|a| a.get(index))
        .with_context(|| format!("accessor {index} missing"))?;
    let acc: Accessor = serde_json::from_value(acc.clone())
        .with_context(|| format!("accessor {index} malformed"))?;
    ensure!(acc.sparse.is_none(), "sparse accessors are not supported");
    ensure!(
        acc.component_type == 5126,
        "accessor {index}: only float32 (5126) is supported, got {}",
        acc.component_type
    );
    let comps = match acc.kind.as_str() {
        "SCALAR" => 1,
        "VEC2" => 2,
        "VEC3" => 3,
        "VEC4" => 4,
        k => bail!("accessor {index}: unsupported type {k}"),
    };
    let bv_index = acc.buffer_view.context("accessor has no bufferView")?;
    let bv = json
        .get("bufferViews")
        .and_then(|b| b.get(bv_index))
        .with_context(|| format!("bufferView {bv_index} missing"))?;
    let bv: BufferView = serde_json::from_value(bv.clone())
        .with_context(|| format!("bufferView {bv_index} malformed"))?;
    ensure!(
        bv.buffer == 0,
        "only buffer 0 (the GLB BIN chunk) is supported"
    );
    let elem = comps * 4;
    let stride = bv.byte_stride.unwrap_or(elem);
    ensure!(
        stride >= elem,
        "bufferView stride {stride} < element size {elem}"
    );

    let mut out = Vec::with_capacity(acc.count * comps);
    for i in 0..acc.count {
        let base = bv.byte_offset + acc.byte_offset + i * stride;
        ensure!(
            base + elem <= bv.byte_offset + bv.byte_length && base + elem <= bin.len(),
            "accessor {index} reads past the BIN chunk"
        );
        for c in 0..comps {
            let o = base + c * 4;
            out.push(f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()));
        }
    }
    Ok((out, comps))
}

/// Rest-pose node hierarchy parsed from glTF `nodes`, index-aligned with the
/// glTF node array.
#[derive(Debug)]
pub struct GltfNodes {
    pub names: Vec<String>,
    /// Parent per node; `usize::MAX` = root.
    pub parents: Vec<usize>,
    pub rest: Vec<NodeTrs>,
    /// Children per node, in glTF `children` order (drives spring-bone
    /// "first child" tail selection, mirroring Unity transform order).
    pub children: Vec<Vec<usize>>,
}

impl GltfNodes {
    pub fn parse(json: &Value) -> Result<GltfNodes> {
        let arr = json.get("nodes").and_then(Value::as_array);
        let arr = arr.map(|a| a.as_slice()).unwrap_or(&[]);
        let n = arr.len();
        let mut names = Vec::with_capacity(n);
        let mut rest = Vec::with_capacity(n);
        let mut children = vec![Vec::new(); n];
        let mut parents = vec![usize::MAX; n];
        for (i, node) in arr.iter().enumerate() {
            names.push(
                node.get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            );
            rest.push(node_trs(node)?);
            if let Some(kids) = node.get("children").and_then(Value::as_array) {
                for kid in kids {
                    let Some(c) = kid.as_u64().map(|c| c as usize) else {
                        continue;
                    };
                    if c < n && parents[c] == usize::MAX && c != i {
                        parents[c] = i;
                        children[i].push(c);
                    }
                }
            }
        }
        Ok(GltfNodes {
            names,
            parents,
            rest,
            children,
        })
    }

    /// Build a pocket3d [`Skeleton`]: parents-first `order` follows a DFS in
    /// glTF child order, so sibling order survives into consumers that only
    /// see the skeleton (e.g. the spring solver's first-child tails).
    pub fn skeleton(&self) -> Skeleton {
        let n = self.parents.len();
        let mut order = Vec::with_capacity(n);
        let mut visited = vec![false; n];
        let mut stack: Vec<usize> = (0..n)
            .rev()
            .filter(|&i| self.parents[i] == usize::MAX)
            .collect();
        while let Some(i) = stack.pop() {
            if visited[i] {
                continue;
            }
            visited[i] = true;
            order.push(i);
            for &c in self.children[i].iter().rev() {
                stack.push(c);
            }
        }
        // Malformed files (cycles, orphan islands): append whatever is left
        // in index order so every node gets a slot.
        for (i, seen) in visited.iter().enumerate() {
            if !seen {
                order.push(i);
            }
        }
        Skeleton {
            parents: self.parents.clone(),
            rest: self.rest.clone(),
            order,
        }
    }

    /// Rest-pose world position of `node` (walks the parent chain).
    pub fn rest_global_position(&self, node: usize) -> Vec3 {
        let mut p = self.rest[node].translation;
        let mut cur = self.parents[node];
        while cur != usize::MAX {
            let t = &self.rest[cur];
            p = t.translation + t.rotation * (t.scale * p);
            cur = self.parents[cur];
        }
        p
    }
}

pub(crate) fn f32_array<const N: usize>(v: &Value) -> Option<[f32; N]> {
    let arr = v.as_array()?;
    if arr.len() < N {
        return None;
    }
    let mut out = [0.0; N];
    for (o, e) in out.iter_mut().zip(arr) {
        *o = e.as_f64()? as f32;
    }
    Some(out)
}

fn node_trs(node: &Value) -> Result<NodeTrs> {
    if let Some(m) = node.get("matrix").and_then(f32_array::<16>) {
        let (scale, rotation, translation) =
            Mat4::from_cols_array(&m).to_scale_rotation_translation();
        return Ok(NodeTrs {
            translation,
            rotation,
            scale,
        });
    }
    let mut trs = NodeTrs::IDENTITY;
    if let Some(t) = node.get("translation").and_then(f32_array::<3>) {
        trs.translation = Vec3::from(t);
    }
    if let Some(r) = node.get("rotation").and_then(f32_array::<4>) {
        trs.rotation = Quat::from_xyzw(r[0], r[1], r[2], r[3]).normalize();
    }
    if let Some(s) = node.get("scale").and_then(f32_array::<3>) {
        trs.scale = Vec3::from(s);
    }
    Ok(trs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a GLB with the given JSON payload and optional BIN chunk,
    /// including spec-mandated 4-byte chunk padding.
    fn make_glb(json: &str, bin: Option<&[u8]>) -> Vec<u8> {
        let mut j = json.as_bytes().to_vec();
        while !j.len().is_multiple_of(4) {
            j.push(b' ');
        }
        let mut out = Vec::new();
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // total length patched below
        out.extend_from_slice(&(j.len() as u32).to_le_bytes());
        out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
        out.extend_from_slice(&j);
        if let Some(bin) = bin {
            let mut b = bin.to_vec();
            while !b.len().is_multiple_of(4) {
                b.push(0);
            }
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
            out.extend_from_slice(&b);
        }
        let total = out.len() as u32;
        out[8..12].copy_from_slice(&total.to_le_bytes());
        out
    }

    #[test]
    fn glb_roundtrip_json_and_bin() {
        let glb = make_glb(r#"{"asset":{"version":"2.0"}}"#, Some(&[1, 2, 3, 4, 5]));
        let parsed = parse_glb(&glb).unwrap();
        assert_eq!(parsed.json["asset"]["version"], "2.0");
        assert_eq!(&parsed.bin[..5], &[1, 2, 3, 4, 5]);
    }

    #[test]
    fn glb_json_only() {
        let glb = make_glb(r#"{"a":1}"#, None);
        let parsed = parse_glb(&glb).unwrap();
        assert_eq!(parsed.json["a"], 1);
        assert!(parsed.bin.is_empty());
    }

    #[test]
    fn glb_bad_magic() {
        let mut glb = make_glb("{}", None);
        glb[0] = b'X';
        assert!(parse_glb(&glb).unwrap_err().to_string().contains("magic"));
    }

    #[test]
    fn glb_too_short() {
        assert!(parse_glb(b"glTF").is_err());
    }

    #[test]
    fn glb_truncated_chunk() {
        let mut glb = make_glb(r#"{"asset":{}}"#, None);
        glb.truncate(glb.len() - 4); // chop the JSON chunk payload short
        assert!(parse_glb(&glb).is_err());
    }

    #[test]
    fn glb_missing_json_chunk() {
        // Header only, no chunks at all.
        let mut out = Vec::new();
        out.extend_from_slice(b"glTF");
        out.extend_from_slice(&2u32.to_le_bytes());
        out.extend_from_slice(&12u32.to_le_bytes());
        assert!(parse_glb(&out).unwrap_err().to_string().contains("JSON"));
    }

    #[test]
    fn glb_unknown_chunk_skipped() {
        let mut glb = make_glb(r#"{"a":2}"#, None);
        // Append an unknown chunk kind; the parser must ignore it.
        glb.extend_from_slice(&4u32.to_le_bytes());
        glb.extend_from_slice(&0xDEAD_BEEFu32.to_le_bytes());
        glb.extend_from_slice(&[0; 4]);
        let total = glb.len() as u32;
        glb[8..12].copy_from_slice(&total.to_le_bytes());
        assert_eq!(parse_glb(&glb).unwrap().json["a"], 2);
    }

    #[test]
    fn accessor_decode_with_stride() {
        // Two VEC3 elements with a 16-byte stride (12 bytes data + 4 pad).
        let mut bin = Vec::new();
        for v in [[1.0f32, 2.0, 3.0], [4.0, 5.0, 6.0]] {
            for f in v {
                bin.extend_from_slice(&f.to_le_bytes());
            }
            bin.extend_from_slice(&[0; 4]);
        }
        let json = format!(
            r#"{{"accessors":[{{"bufferView":0,"componentType":5126,"count":2,"type":"VEC3"}}],
                "bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{},"byteStride":16}}]}}"#,
            bin.len()
        );
        let glb = make_glb(&json, Some(&bin));
        let parsed = parse_glb(&glb).unwrap();
        let (vals, comps) = read_f32_accessor(&parsed.json, parsed.bin, 0).unwrap();
        assert_eq!(comps, 3);
        assert_eq!(vals, vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0]);
    }

    #[test]
    fn accessor_out_of_bounds_rejected() {
        let json = r#"{"accessors":[{"bufferView":0,"componentType":5126,"count":4,"type":"VEC4"}],
                       "bufferViews":[{"buffer":0,"byteOffset":0,"byteLength":8}]}"#;
        let glb = make_glb(json, Some(&[0; 8]));
        let parsed = parse_glb(&glb).unwrap();
        assert!(read_f32_accessor(&parsed.json, parsed.bin, 0).is_err());
    }
}
