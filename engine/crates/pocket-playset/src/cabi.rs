//! C ABI for device hosts (include/pocket_playset.h). Every pointer argument
//! is borrowed for the call; returned pointers stay valid as documented in
//! the header.

use crate::render::Frame;
use crate::schema::view as V;
use crate::vec::*;
use crate::Playset;
use alloc::boxed::Box;

unsafe fn floats<'a>(p: *const f32, n: u32) -> &'a [f32] {
    if p.is_null() || n == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(p, n as usize)
    }
}

unsafe fn ps<'a>(p: *mut Playset) -> Option<&'a mut Playset> {
    p.as_mut()
}

#[no_mangle]
pub extern "C" fn pps_create(capacity: u32, particles: u32) -> *mut Playset {
    Box::into_raw(Playset::new(capacity as usize, particles as usize))
}

/// # Safety
/// `p` comes from `pps_create` and no view of it is used afterwards.
#[no_mangle]
pub unsafe extern "C" fn pps_destroy(p: *mut Playset) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

/// A float view over the world's memory; stable until `pps_destroy`.
///
/// # Safety
/// `p` is a live playset; `length` may be null.
#[no_mangle]
pub unsafe extern "C" fn pps_view(p: *mut Playset, which: u32, length: *mut u32) -> *mut f32 {
    let Some(s) = ps(p) else { return core::ptr::null_mut() };
    let (ptr, len) = match which {
        V::ENT => (s.world.ent.as_mut_ptr(), s.world.ent.len()),
        V::INTENT => (s.world.intent.as_mut_ptr(), s.world.intent.len()),
        V::USER => (s.world.user.as_mut_ptr(), s.world.user.len()),
        V::EVENTS => (s.world.events.as_mut_ptr(), s.world.events.len()),
        V::LIST => (s.world.list.as_mut_ptr(), s.world.list.len()),
        V::JOINT => (s.world.joint.as_mut_ptr(), s.world.joint.len()),
        V::LOOK => (s.world.look.as_mut_ptr(), s.world.look.len()),
        V::CAMERA => (s.camera_out.as_mut_ptr(), s.camera_out.len()),
        V::STATS => (s.stats.as_mut_ptr(), s.stats.len()),
        _ => (core::ptr::null_mut(), 0),
    };
    if !length.is_null() {
        *length = len as u32;
    }
    ptr
}

/// # Safety
/// `desc` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_model(p: *mut Playset, desc: *const f32, n: u32) -> i32 {
    let Some(s) = ps(p) else { return -1 };
    match s.scene.add_model(floats(desc, n)) {
        Ok(id) => id as i32,
        Err(e) => -2 - e as i32,
    }
}

/// `xf`: x, y, z, yaw, pitch, roll, scale.
unsafe fn xf_matrix(xf: *const f32) -> Mat34 {
    let x = floats(xf, 7);
    if x.len() < 7 {
        return Mat34::IDENTITY;
    }
    Mat34::from_ypr(v3(x[0], x[1], x[2]), x[3], x[4], x[5], if x[6] != 0.0 { x[6] } else { 1.0 })
}

/// # Safety
/// `xf` points at 7 floats, or at 12 when `flags` bit 31 says it is a 3x4 matrix.
#[no_mangle]
pub unsafe extern "C" fn pps_node(p: *mut Playset, model: i32, xf: *const f32, flags: u32) -> i32 {
    let Some(s) = ps(p) else { return -1 };
    if model < 0 {
        return -1;
    }
    let m = if flags & 0x8000_0000 != 0 {
        let mut a = [0.0f32; 12];
        a.copy_from_slice(floats(xf, 12));
        Mat34(a)
    } else {
        xf_matrix(xf)
    };
    s.scene.add_node(model as u32, m, flags & 0x7fff_ffff)
}

/// # Safety
/// As `pps_node`.
#[no_mangle]
pub unsafe extern "C" fn pps_node_set(p: *mut Playset, node: i32, xf: *const f32, flags: u32) {
    let Some(s) = ps(p) else { return };
    if node < 0 {
        return;
    }
    let m = if flags & 0x8000_0000 != 0 {
        let mut a = [0.0f32; 12];
        a.copy_from_slice(floats(xf, 12));
        Mat34(a)
    } else {
        xf_matrix(xf)
    };
    s.scene.set_node(node as usize, m, flags & 0x7fff_ffff);
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_node_remove(p: *mut Playset, node: i32) {
    if let Some(s) = ps(p) {
        if node >= 0 {
            s.scene.remove_node(node as usize);
        }
    }
}

/// # Safety
/// `params` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_env(p: *mut Playset, kind: u32, params: *const f32, n: u32) {
    if let Some(s) = ps(p) {
        s.env(kind, floats(params, n));
    }
}

/// Heights row-major (row 0 at -Z) centred on `origin`; bands (h, r, g, b).
///
/// # Safety
/// Array arguments point at their counts.
#[no_mangle]
pub unsafe extern "C" fn pps_terrain(
    p: *mut Playset,
    w: u32,
    h: u32,
    cell: f32,
    origin: *const f32,
    heights: *const f32,
    hn: u32,
    bands: *const f32,
    bn: u32,
) {
    let Some(s) = ps(p) else { return };
    let o = floats(origin, 3);
    let origin = if o.len() == 3 { v3(o[0], o[1], o[2]) } else { Vec3::ZERO };
    s.scene.set_terrain(w as usize, h as usize, cell, origin, floats(heights, hn), floats(bands, bn));
}

/// shape 1: box (cx, cy, cz, hx, hy, hz, yaw); 2: cylinder (cx, cy, cz, r, half height).
///
/// # Safety
/// `params` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_collider(p: *mut Playset, shape: u32, params: *const f32, n: u32) -> i32 {
    let Some(s) = ps(p) else { return -1 };
    let a = floats(params, n);
    let g = |i: usize| a.get(i).copied().unwrap_or(0.0);
    let c = match shape {
        1 => crate::scene::Collider::Box { c: v3(g(0), g(1), g(2)), half: v3(g(3), g(4), g(5)), yaw: g(6) },
        2 => crate::scene::Collider::Cylinder { c: v3(g(0), g(1), g(2)), r: g(3), half_h: g(4) },
        _ => return -1,
    };
    s.scene.colliders.push(c);
    (s.scene.colliders.len() - 1) as i32
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_colliders_clear(p: *mut Playset) {
    if let Some(s) = ps(p) {
        s.scene.colliders.clear();
    }
}

/// # Safety
/// `desc` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_arch(p: *mut Playset, desc: *const f32, n: u32) -> i32 {
    match ps(p) {
        Some(s) => s.world.add_arch(floats(desc, n)),
        None => -1,
    }
}

/// # Safety
/// `desc` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_arch_set(p: *mut Playset, id: i32, desc: *const f32, n: u32) {
    if let Some(s) = ps(p) {
        if id >= 0 {
            s.world.set_arch(id as usize, floats(desc, n));
        }
    }
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_rule(p: *mut Playset, a: u32, b: u32, flags: u32, value: f32) -> i32 {
    match ps(p) {
        Some(s) => s.world.add_rule(a, b, flags, value),
        None => -1,
    }
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_rules_clear(p: *mut Playset) {
    if let Some(s) = ps(p) {
        s.world.rules.clear();
    }
}

/// # Safety
/// `pts` points at `n` floats (x, y, z triples).
#[no_mangle]
pub unsafe extern "C" fn pps_path(p: *mut Playset, pts: *const f32, n: u32) -> i32 {
    match ps(p) {
        Some(s) => s.world.add_path(floats(pts, n)),
        None => -1,
    }
}

/// # Safety
/// `desc` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_emitter(p: *mut Playset, desc: *const f32, n: u32) -> i32 {
    match ps(p) {
        Some(s) => s.world.fx.add_emitter(floats(desc, n)),
        None => -1,
    }
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_spawn(p: *mut Playset, arch: i32, x: f32, y: f32, z: f32, yaw: f32) -> i32 {
    let Some(s) = ps(p) else { return -1 };
    if arch < 0 {
        return -1;
    }
    s.world.spawn(&s.scene, arch as usize, v3(x, y, z), yaw)
}

/// mode 0 silent, 1 effects, 2 event and effects. Takes effect at once.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_kill(p: *mut Playset, slot: i32, mode: i32) {
    let Some(s) = ps(p) else { return };
    if slot >= 0 && (slot as usize) < s.world.cap {
        s.world.kill_mode(slot as usize, -1, mode.clamp(0, 2) as u8);
        s.world.bury();
    }
}

/// Remove every slot and particle; content, archetypes and rules stay.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_clear(p: *mut Playset) {
    let Some(s) = ps(p) else { return };
    let live: alloc::vec::Vec<u16> = s.world.live.clone();
    for slot in live {
        s.world.kill_mode(slot as usize, -1, crate::world::KILL_SILENT);
    }
    // slots kept on death are freed too
    s.world.force_release_all();
    s.world.fx.pool.clear();
    s.world.event_count = 0;
    s.world.step_events = 0;
}

/// Bring a KEEP_ON_DEATH slot back with `hp`.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_revive(p: *mut Playset, slot: i32, hp: f32) {
    let Some(s) = ps(p) else { return };
    if slot >= 0 && (slot as usize) < s.world.cap && s.world.arch_of(slot as usize).is_some() {
        let slot = slot as usize;
        s.world.set_state_bit(slot, crate::schema::state::DEAD, false);
        s.world.set(slot, crate::schema::ent::HP, hp);
        s.world.s[slot].hurt = 0.0;
    }
}

/// Ride on `parent` at offset (x, y, z) with yaw offset; follow = 1 copies its attitude.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_attach(p: *mut Playset, slot: i32, parent: i32, x: f32, y: f32, z: f32, yaw: f32, follow: i32) {
    let Some(s) = ps(p) else { return };
    if slot < 0 || slot as usize >= s.world.cap {
        return;
    }
    let st = &mut s.world.s[slot as usize];
    st.parent = parent;
    st.k[0] = x;
    st.k[1] = y;
    st.k[2] = z;
    st.k[3] = yaw;
    st.k[4] = if follow != 0 { 1.0 } else { 0.0 };
}

/// Move a slot to other layers and team.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_layer(p: *mut Playset, slot: i32, layer: u32, mask: u32, team: i32) {
    let Some(s) = ps(p) else { return };
    if slot >= 0 && (slot as usize) < s.world.cap {
        let st = &mut s.world.s[slot as usize];
        st.layer = layer;
        st.mask = mask;
        st.team = team;
    }
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_emit(p: *mut Playset, emitter: i32, x: f32, y: f32, z: f32, count: f32) {
    let Some(s) = ps(p) else { return };
    if emitter >= 0 {
        let w = &mut s.world;
        w.fx.emit(emitter as usize, v3(x, y, z), Vec3::ZERO, count, &mut w.rng);
    }
}

/// Fire a slot's weapon now, ignoring its cooldown.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_fire(p: *mut Playset, slot: i32, weapon: i32) {
    let Some(s) = ps(p) else { return };
    if slot < 0 || slot as usize >= s.world.cap || !(0..2).contains(&weapon) {
        return;
    }
    if let Some(arch) = s.world.arch_of(slot as usize) {
        s.world.fire(&s.scene, slot as usize, arch, weapon as usize);
    }
}

/// Synthesize a sound description (PLAYSET_SOUND); its id.
///
/// # Safety
/// `desc` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_sound(p: *mut Playset, desc: *const f32, n: u32) -> i32 {
    match ps(p) {
        Some(s) => s.world.audio.add(floats(desc, n)),
        None => -1,
    }
}

/// A sound's PCM: mono s16 at `rate`; stable for the playset's lifetime.
///
/// # Safety
/// Out pointers are writable.
#[no_mangle]
pub unsafe extern "C" fn pps_sound_data(p: *mut Playset, id: u32, pcm: *mut *const i16, samples: *mut u32, rate: *mut u32, looping: *mut u32) -> i32 {
    let Some(s) = ps(p) else { return -1 };
    let Some(snd) = s.world.audio.sounds.get(id as usize) else { return -1 };
    *pcm = snd.pcm.as_ptr();
    *samples = snd.pcm.len() as u32;
    *rate = snd.rate;
    *looping = snd.looping as u32;
    0
}

/// kind PLAY: a one-shot at (x, y, z) when `placed`, else straight to the
/// speakers; LOOP returns its voice; SET and STOP name the voice in `sound`.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_sound_play(p: *mut Playset, kind: u32, sound: i32, volume: f32, pitch: f32, pan_or_x: f32, y: f32, z: f32, placed: i32) -> i32 {
    use crate::schema::voice as VO;
    let Some(s) = ps(p) else { return -1 };
    let a = &mut s.world.audio;
    match kind {
        VO::PLAY if sound >= 0 => {
            a.play(sound as u32, volume, if pitch > 0.0 { pitch } else { 1.0 }, if placed != 0 { Some(v3(pan_or_x, y, z)) } else { None });
            0
        }
        VO::LOOP if sound >= 0 => a.start_loop(sound as u32, volume, if pitch > 0.0 { pitch } else { 1.0 }),
        VO::SET => {
            a.set_loop(sound, volume, if pitch > 0.0 { pitch } else { 1.0 }, pan_or_x);
            0
        }
        VO::STOP => {
            a.stop_loop(sound);
            0
        }
        _ => -1,
    }
}

/// The frame's mixer requests, built by the last prepare.
///
/// # Safety
/// `count` is writable.
#[no_mangle]
pub unsafe extern "C" fn pps_audio_requests(p: *mut Playset, count: *mut u32) -> *const crate::audio::Request {
    let Some(s) = ps(p) else {
        *count = 0;
        return core::ptr::null();
    };
    *count = s.world.audio.out.len() as u32;
    s.world.audio.out.as_ptr()
}

/// 0..1 for everything the playset plays.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_audio_master(p: *mut Playset, volume: f32) {
    if let Some(s) = ps(p) {
        s.world.audio.master = crate::fmath::clampf(volume, 0.0, 1.0);
    }
}

/// A genre module's call (modules/mod.rs): `args` in, results in `out`.
///
/// # Safety
/// `args` points at `n` floats and `out` at `nout` writable floats.
#[no_mangle]
pub unsafe extern "C" fn pps_call(p: *mut Playset, module: u32, op: u32, args: *const f32, n: u32, out: *mut f32, nout: u32) -> f32 {
    let Some(s) = ps(p) else { return -1.0 };
    let a = floats(args, n);
    let o: &mut [f32] = if out.is_null() || nout == 0 { &mut [] } else { core::slice::from_raw_parts_mut(out, nout as usize) };
    s.modules.call(&mut s.world, &mut s.scene, module, op, a, o)
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_step(p: *mut Playset, dt: f32) -> i32 {
    match ps(p) {
        Some(s) => s.step(dt) as i32,
        None => 0,
    }
}

/// # Safety
/// `desc` points at `n` floats.
#[no_mangle]
pub unsafe extern "C" fn pps_camera(p: *mut Playset, desc: *const f32, n: u32) {
    if let Some(s) = ps(p) {
        s.rig.set(floats(desc, n));
    }
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_query(p: *mut Playset, kind: u32, a: f32, b: f32, c: f32, d: f32) -> f32 {
    match ps(p) {
        Some(s) => s.world.query(&s.scene, kind, a, b, c, d),
        None => 0.0,
    }
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_seed(p: *mut Playset, seed: u32) {
    if let Some(s) = ps(p) {
        s.world.rng = crate::fmath::Rng(seed);
    }
}

/// # Safety
/// `p` is live. The frame stays valid until the next prepare or destroy.
#[no_mangle]
pub unsafe extern "C" fn pps_prepare(p: *mut Playset, aspect: f32) -> *const Frame {
    match ps(p) {
        Some(s) => s.prepare(aspect),
        None => core::ptr::null(),
    }
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_model_count(p: *mut Playset) -> u32 {
    ps(p).map_or(0, |s| s.scene.models.len() as u32)
}

/// Vertex (20 bytes each) and index arrays of a model; stable for its lifetime.
///
/// # Safety
/// Out pointers are writable.
#[no_mangle]
pub unsafe extern "C" fn pps_model_data(
    p: *mut Playset,
    id: u32,
    verts: *mut *const u8,
    nverts: *mut u32,
    idx: *mut *const u16,
    nidx: *mut u32,
) -> i32 {
    let Some(s) = ps(p) else { return -1 };
    let Some(m) = s.scene.models.get(id as usize) else { return -1 };
    *verts = m.verts.as_ptr() as *const u8;
    *nverts = m.verts.len() as u32;
    *idx = m.idx.as_ptr();
    *nidx = m.idx.len() as u32;
    0
}

/// source 1 static batches, 2 ground tiles. `revision` changes when the
/// arrays were rebuilt.
///
/// # Safety
/// Out pointers are writable.
#[no_mangle]
pub unsafe extern "C" fn pps_batch_data(
    p: *mut Playset,
    source: u32,
    id: u32,
    verts: *mut *const u8,
    nverts: *mut u32,
    idx: *mut *const u16,
    nidx: *mut u32,
    revision: *mut u32,
) -> i32 {
    let Some(s) = ps(p) else { return -1 };
    let list = if source == 2 { &s.scene.ground } else { &s.scene.batches };
    let Some(b) = list.get(id as usize) else { return -1 };
    *verts = b.verts.as_ptr() as *const u8;
    *nverts = b.verts.len() as u32;
    *idx = b.idx.as_ptr();
    *nidx = b.idx.len() as u32;
    *revision = b.revision;
    0
}

/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_batch_count(p: *mut Playset, source: u32) -> u32 {
    ps(p).map_or(0, |s| if source == 2 { s.scene.ground.len() as u32 } else { s.scene.batches.len() as u32 })
}

/// The host's measurements into the STATS view.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_note_timing(p: *mut Playset, step_us: f32, prepare_us: f32, render_us: f32) {
    if let Some(s) = ps(p) {
        use crate::schema::stat as S;
        if step_us >= 0.0 {
            s.stats[S::STEP_US] = step_us;
        }
        if prepare_us >= 0.0 {
            s.stats[S::PREPARE_US] = prepare_us;
        }
        if render_us >= 0.0 {
            s.stats[S::RENDER_US] = render_us;
        }
    }
}

/// Segment caps for primitives built after this call.
///
/// # Safety
/// `p` is live.
#[no_mangle]
pub unsafe extern "C" fn pps_lod(p: *mut Playset, radial: u32, rings: u32, tubular: u32) {
    if let Some(s) = ps(p) {
        s.scene.lod = crate::geom::Lod { radial: radial.clamp(3, 48), rings: rings.clamp(2, 32), tubular: tubular.clamp(3, 64) };
    }
}
