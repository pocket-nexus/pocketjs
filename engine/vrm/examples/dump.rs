//! Debug dump: which humanoid bones a .vrma animates, and which of them
//! survive retargeting onto a model. `cargo run -p pocket-vrm --example dump
//! -- <model.vrm> <anim.vrma>`.

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let vrm = pocket_vrm::VrmDoc::from_path(std::path::Path::new(&args[1]))?;
    let vrma = pocket_vrm::load_vrma_bytes(&std::fs::read(&args[2])?)?;

    println!("model humanoid bones: {}", vrm.humanoid.len());
    println!("vrma humanoid bones: {:?}", vrma.humanoid);
    println!("vrma channels: {}", vrma.channels.len());

    let model_bones: std::collections::HashSet<&str> =
        vrm.humanoid.iter().map(|(n, _)| n.as_str()).collect();
    for (name, node) in &vrma.humanoid {
        let mapped = model_bones.contains(name.as_str());
        let n_ch = vrma.channels.iter().filter(|c| c.node == *node).count();
        println!(
            "  {name:<20} vrma-node {node:<3} channels {n_ch} {}",
            if mapped { "-> mapped" } else { "-> DROPPED (no model bone)" }
        );
    }

    let skel = vrm.skeleton();
    let clip = pocket_vrm::retarget(&vrma, &vrm.humanoid, &skel)?;
    println!("retargeted clip: {} channels, {:.3}s", clip.channels.len(), clip.duration);
    for ch in &clip.channels {
        let bone = vrm
            .humanoid
            .iter()
            .find(|(_, n)| *n == ch.node)
            .map(|(b, _)| b.as_str())
            .unwrap_or("?");
        let path = match ch.path {
            pocket3d::anim::ChannelPath::Translation => "T",
            pocket3d::anim::ChannelPath::Rotation => "R",
            pocket3d::anim::ChannelPath::Scale => "S",
        };
        // First-key value so wrong-space rotations show up immediately.
        let v: Vec<f32> = ch.values.iter().take(4).copied().collect();
        println!("  node {:<3} {bone:<18} {path} keys {:<4} first {v:?}", ch.node, ch.times.len());
    }
    Ok(())
}
