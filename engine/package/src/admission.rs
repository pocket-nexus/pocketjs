//! Device admission: whether a host provides what a package variant was
//! compiled to use.
//!
//! A variant is admitted when each item holds:
//!
//!   binding generation  variant.hostAbi == the host's binding generation
//!   raster density      plan.viewport.rasterDensity == the host's density
//!   animation           plan.animation == the host's animation class
//!   rate                plan.profile.tickHz (1..=240) is a whole multiple,
//!                       at most 60, of one of the host's cadences
//!   viewport            plan.viewport.logical is listed by the host or lies
//!                       inside its dynamic range
//!   presentation        plan.viewport.presentation is listed by the host
//!   capability          every `features.<name>: true` is a host capability
//!   auxiliary           plan.surfaces.auxiliary.logical is a host auxiliary
//!                       size at the host's density; skipped when absent
//!
//! Names compare as bytes; order and extra host entries do not matter. A
//! host that states no animation class or no presentation list (a C facts
//! record written before those fields existed) is not compared on them. The
//! profile hash, id, platform, form and physical panel size do not
//! participate. Selection prefers variants whose profile hash equals the
//! host's, then takes variants in file order; the first admitted variant
//! wins. When none is admitted, the variant with the fewest failed items is
//! reported with those items.

use core::fmt;

use crate::plan_facts::{plan_facts, PlanFacts};

/// Admission items. A [`Mismatch`] carries the failed ones as a bit set.
pub mod item {
    pub const BINDING_GENERATION: u32 = 1 << 0;
    /// The plan section is absent, empty or unreadable.
    pub const PLAN: u32 = 1 << 1;
    pub const RASTER_DENSITY: u32 = 1 << 2;
    pub const ANIMATION: u32 = 1 << 3;
    pub const RATE: u32 = 1 << 4;
    pub const VIEWPORT: u32 = 1 << 5;
    pub const PRESENTATION: u32 = 1 << 6;
    pub const CAPABILITY: u32 = 1 << 7;
    pub const AUXILIARY: u32 = 1 << 8;
}

/// Item bits and the names diagnostics print, in check order.
pub const ITEMS: [(u32, &str); 9] = [
    (item::BINDING_GENERATION, "bindingGeneration"),
    (item::PLAN, "plan"),
    (item::RASTER_DENSITY, "rasterDensity"),
    (item::ANIMATION, "animation"),
    (item::RATE, "rate"),
    (item::VIEWPORT, "viewport"),
    (item::PRESENTATION, "presentation"),
    (item::CAPABILITY, "capability"),
    (item::AUXILIARY, "auxiliary"),
];

/// The core's largest tick rate (`pocketjs_core::MAX_TICK_HZ`). Manifests
/// cap an application's rate at 60; embeddings that compile their own code
/// may run faster.
pub const MAX_TICK_HZ: u32 = 240;
/// The most core ticks one presented frame advances, the bound of
/// `Runtime::advance_with_core_ticks`.
pub const MAX_CORE_TICKS_PER_FRAME: u32 = 60;

/// What a host provides, read from its exported profile facts.
#[derive(Clone, Copy, Debug)]
pub struct HostFacts<'a, S: AsRef<str>> {
    pub binding_generation: u32,
    /// Provenance only: variants with this hash are tried first.
    pub profile_hash: [u8; 32],
    pub raster_density: u32,
    /// None: the host states no class and admits any.
    pub animation: Option<&'a str>,
    /// Presented frames per second the host can drive.
    pub cadences: &'a [u32],
    pub logical_viewports: &'a [[u32; 2]],
    /// `[min, max]` logical sizes of a window or widget form.
    pub dynamic_viewport: Option<[[u32; 2]; 2]>,
    /// None: the host states no list and admits any presentation.
    pub presentations: Option<&'a [S]>,
    pub capabilities: &'a [S],
    /// Empty when the host has no auxiliary display.
    pub auxiliary_logical: &'a [[u32; 2]],
}

impl<S: AsRef<str>> HostFacts<'_, S> {
    pub fn admits_viewport(&self, size: [u32; 2]) -> bool {
        match self.dynamic_viewport {
            Some([min, max]) => {
                size[0] >= min[0] && size[1] >= min[1] && size[0] <= max[0] && size[1] <= max[1]
            }
            None => self.logical_viewports.contains(&size),
        }
    }
}

/// The package rate and the host cadence an admitted variant runs at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    /// Core ticks per virtual second (`plan.profile.tickHz`).
    pub tick_hz: u32,
    /// Presented frames per second.
    pub cadence_hz: u32,
}

impl Timing {
    /// Core ticks run for each presented frame.
    pub fn core_ticks(&self) -> u32 {
        self.tick_hz / self.cadence_hz
    }
}

/// The largest host cadence that divides `tick_hz` with at most
/// [`MAX_CORE_TICKS_PER_FRAME`] core ticks per frame.
pub fn cadence_for(tick_hz: u32, cadences: &[u32]) -> Option<u32> {
    if !(1..=MAX_TICK_HZ).contains(&tick_hz) {
        return None;
    }
    cadences
        .iter()
        .copied()
        .filter(|&cadence| {
            cadence != 0 && tick_hz % cadence == 0 && tick_hz / cadence <= MAX_CORE_TICKS_PER_FRAME
        })
        .max()
}

/// A capability name copied out of the package, for diagnostics.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Name {
    bytes: [u8; 48],
    length: u8,
}

impl Name {
    pub const EMPTY: Self = Self {
        bytes: [0; 48],
        length: 0,
    };
    fn copy(name: &[u8]) -> Self {
        let mut value = Self::EMPTY;
        let length = name.len().min(value.bytes.len());
        value.bytes[..length].copy_from_slice(&name[..length]);
        value.length = length as u8;
        value
    }
    /// The name's bytes, truncated to 48; empty when no capability is missing.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.length as usize]
    }
    pub fn as_str(&self) -> &str {
        core::str::from_utf8(self.as_bytes()).unwrap_or("")
    }
}

impl fmt::Debug for Name {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self.as_str(), formatter)
    }
}

/// The variant closest to admission and the items it fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mismatch {
    /// File-order index of the reported variant.
    pub variant: u32,
    /// [`item`] bits.
    pub items: u32,
    /// The first enabled feature the host lacks when `items` has
    /// [`item::CAPABILITY`].
    pub capability: Name,
}

impl Mismatch {
    /// The first failed item in check order.
    pub fn first(&self) -> u32 {
        ITEMS
            .iter()
            .map(|(bit, _)| *bit)
            .find(|bit| self.items & bit != 0)
            .unwrap_or(0)
    }
}

impl fmt::Display for Mismatch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "variant {} is not admitted:", self.variant)?;
        for (bit, name) in ITEMS {
            if self.items & bit == 0 {
                continue;
            }
            if bit == item::CAPABILITY && self.capability.length != 0 {
                write!(formatter, " capability {}", self.capability.as_str())?;
            } else {
                write!(formatter, " {name}")?;
            }
        }
        Ok(())
    }
}

/// Check one variant's plan against the host. `Err` carries failed item bits
/// and the first missing capability.
pub fn admit_plan<S: AsRef<str>>(
    host: &HostFacts<'_, S>,
    variant_generation: u32,
    plan: Option<&[u8]>,
) -> Result<Timing, (u32, Name)> {
    let mut items = 0;
    if variant_generation != host.binding_generation {
        items |= item::BINDING_GENERATION;
    }
    let facts: PlanFacts<'_> = match plan.filter(|plan| !plan.is_empty()).map(plan_facts) {
        Some(Ok(facts)) => facts,
        _ => return Err((items | item::PLAN, Name::EMPTY)),
    };
    if facts.viewport.raster_density != host.raster_density {
        items |= item::RASTER_DENSITY;
    }
    if host
        .animation
        .is_some_and(|animation| facts.animation != Some(animation.as_bytes()))
    {
        items |= item::ANIMATION;
    }
    let timing = facts.tick_hz.and_then(|tick_hz| {
        cadence_for(tick_hz, host.cadences).map(|cadence_hz| Timing {
            tick_hz,
            cadence_hz,
        })
    });
    if timing.is_none() {
        items |= item::RATE;
    }
    if !host.admits_viewport([facts.viewport.width, facts.viewport.height]) {
        items |= item::VIEWPORT;
    }
    if let Some(presentations) = host.presentations {
        if !facts
            .presentation
            .is_some_and(|presentation| contains(presentations, presentation))
        {
            items |= item::PRESENTATION;
        }
    }
    let mut capability = Name::EMPTY;
    if let Some(missing) = facts
        .enabled_features()
        .find(|name| !contains(host.capabilities, name))
    {
        items |= item::CAPABILITY;
        capability = Name::copy(missing);
    }
    if let Some(auxiliary) = facts.auxiliary {
        if auxiliary.raster_density != host.raster_density
            || !host
                .auxiliary_logical
                .contains(&[auxiliary.width, auxiliary.height])
        {
            items |= item::AUXILIARY;
        }
    }
    match timing {
        Some(timing) if items == 0 => Ok(timing),
        _ => Err((items, capability)),
    }
}

fn contains<S: AsRef<str>>(names: &[S], name: &[u8]) -> bool {
    names
        .iter()
        .any(|candidate| candidate.as_ref().as_bytes() == name)
}

/// A plan and host that admit each other, for this crate's tests.
#[cfg(test)]
pub(crate) mod testing {
    use super::HostFacts;
    pub const PLAN: &[u8] = br#"{"animation":"composited","features":{},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;
    pub fn host(generation: u32, profile_hash: [u8; 32]) -> HostFacts<'static, &'static str> {
        HostFacts {
            binding_generation: generation,
            profile_hash,
            raster_density: 1,
            animation: Some("composited"),
            cadences: &[60],
            logical_viewports: &[[480, 272]],
            dynamic_viewport: None,
            presentations: Some(&["native"]),
            capabilities: &["input.buttons", "text.glyphs.baked"],
            auxiliary_logical: &[],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAN: &[u8] = br#"{"animation":"composited","features":{"input.buttons":true,"io.offload":false,"text.glyphs.baked":true},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;

    fn host() -> HostFacts<'static, &'static str> {
        HostFacts {
            binding_generation: 12,
            profile_hash: [1; 32],
            raster_density: 1,
            animation: Some("composited"),
            cadences: &[60, 30],
            logical_viewports: &[[480, 272]],
            dynamic_viewport: None,
            presentations: Some(&["native", "integer-fit"]),
            capabilities: &["input.buttons", "text.glyphs.baked"],
            auxiliary_logical: &[],
        }
    }

    #[test]
    fn a_satisfying_host_admits_and_picks_the_fastest_cadence() {
        assert_eq!(
            admit_plan(&host(), 12, Some(PLAN)),
            Ok(Timing {
                tick_hz: 60,
                cadence_hz: 60
            })
        );
        let slow = HostFacts {
            cadences: &[30, 20],
            ..host()
        };
        let timing = admit_plan(&slow, 12, Some(PLAN)).unwrap();
        assert_eq!((timing.cadence_hz, timing.core_ticks()), (30, 2));
    }

    #[test]
    fn each_item_is_reported() {
        let failed = |host: HostFacts<'static, &'static str>| {
            admit_plan(&host, 12, Some(PLAN)).unwrap_err().0
        };
        assert_eq!(
            admit_plan(&host(), 11, Some(PLAN)).unwrap_err().0,
            item::BINDING_GENERATION
        );
        assert_eq!(
            failed(HostFacts {
                raster_density: 2,
                ..host()
            }),
            item::RASTER_DENSITY
        );
        assert_eq!(
            failed(HostFacts {
                animation: Some("repaint"),
                ..host()
            }),
            item::ANIMATION
        );
        assert_eq!(
            failed(HostFacts {
                cadences: &[25, 7],
                ..host()
            }),
            item::RATE
        );
        assert_eq!(
            failed(HostFacts {
                logical_viewports: &[[400, 240]],
                ..host()
            }),
            item::VIEWPORT
        );
        assert_eq!(
            failed(HostFacts {
                presentations: Some(&["fit"]),
                ..host()
            }),
            item::PRESENTATION
        );
        let unstated = HostFacts {
            animation: None,
            presentations: None,
            ..host()
        };
        assert!(admit_plan(&unstated, 12, Some(PLAN)).is_ok());
        let (items, name) = admit_plan(
            &HostFacts {
                capabilities: &["input.buttons"],
                ..host()
            },
            12,
            Some(PLAN),
        )
        .unwrap_err();
        assert_eq!(
            (items, name.as_str()),
            (item::CAPABILITY, "text.glyphs.baked")
        );
        assert_eq!(admit_plan(&host(), 12, None).unwrap_err().0, item::PLAN);
        assert_eq!(
            admit_plan(&host(), 12, Some(b"")).unwrap_err().0,
            item::PLAN
        );
    }

    #[test]
    fn rates_need_a_dividing_cadence_within_sixty_ticks_per_frame() {
        assert_eq!(cadence_for(120, &[60]), Some(60));
        assert_eq!(cadence_for(120, &[1]), None);
        assert_eq!(cadence_for(241, &[241]), None);
        assert_eq!(cadence_for(60, &[1]), Some(1));
        assert_eq!(cadence_for(60, &[0, 45]), None);
        assert_eq!(cadence_for(30, &[60, 30, 15]), Some(30));
    }

    #[test]
    fn auxiliary_surfaces_must_be_hosted() {
        let plan = br#"{"animation":"composited","features":{},"profile":{"tickHz":60},"surfaces":{"auxiliary":{"logical":[320,240],"rasterDensity":1}},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;
        assert_eq!(
            admit_plan(&host(), 12, Some(plan)).unwrap_err().0,
            item::AUXILIARY
        );
        let dual = HostFacts {
            auxiliary_logical: &[[320, 240]],
            ..host()
        };
        assert!(admit_plan(&dual, 12, Some(plan)).is_ok());
    }

    #[test]
    fn mismatch_formats_its_items() {
        let mismatch = Mismatch {
            variant: 1,
            items: item::CAPABILITY | item::RATE,
            capability: Name::copy(b"net.http"),
        };
        assert_eq!(mismatch.first(), item::RATE);
        assert_eq!(
            std::format!("{mismatch}"),
            "variant 1 is not admitted: rate capability net.http"
        );
    }
}
