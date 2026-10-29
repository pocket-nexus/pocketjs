//! The shared admission corpus: contracts/spec/admission.ts reads the same
//! package and cases (tests/package-admission.test.ts). Regenerate both with
//! `bun tools/package-corpus.ts`.
use pocket_package::{admission::ITEMS, select_guest, GuestError, HostFacts, Timing};
use serde_json::Value;

const PACKAGE: &[u8] = include_bytes!("fixtures/admission/package.pocket");
const CASES: &str = include_str!("fixtures/admission/cases.json");

fn sizes(value: &Value) -> Vec<[u32; 2]> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|size| [size[0].as_u64().unwrap() as u32, size[1].as_u64().unwrap() as u32])
                .collect()
        })
        .unwrap_or_default()
}
fn strings(value: &Value) -> Vec<&str> {
    value
        .as_array()
        .map(|items| items.iter().map(|item| item.as_str().unwrap()).collect())
        .unwrap_or_default()
}

#[test]
fn engine_admission_matches_the_shared_corpus() {
    let cases: Value = serde_json::from_str(CASES).unwrap();
    let cases = cases.as_array().unwrap();
    assert!(cases.len() >= 10);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let host = &case["host"];
        let mut profile_hash = [0u8; 32];
        let hex = host["profileHash"].as_str().unwrap().strip_prefix("sha256:").unwrap();
        for (index, byte) in profile_hash.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap();
        }
        let cadences: Vec<u32> = host["cadences"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_u64().unwrap() as u32)
            .collect();
        let logical = sizes(&host["logicalViewports"]);
        let auxiliary = sizes(&host["auxiliaryLogical"]);
        let presentations = strings(&host["presentations"]);
        let capabilities = strings(&host["capabilities"]);
        let dynamic = host.get("dynamicViewport").map(|range| {
            let pair = |value: &Value| [value[0].as_u64().unwrap() as u32, value[1].as_u64().unwrap() as u32];
            [pair(&range["min"]), pair(&range["max"])]
        });
        let facts = HostFacts {
            binding_generation: host["bindingGeneration"].as_u64().unwrap() as u32,
            profile_hash,
            raster_density: host["rasterDensity"].as_u64().unwrap() as u32,
            animation: host["animation"].as_str(),
            cadences: &cadences,
            logical_viewports: &logical,
            dynamic_viewport: dynamic,
            presentations: host.get("presentations").map(|_| presentations.as_slice()),
            capabilities: &capabilities,
            auxiliary_logical: &auxiliary,
        };
        let result = select_guest(PACKAGE, &facts, false);
        if let Some(admitted) = case.get("admitted") {
            let guest = result.unwrap_or_else(|error| panic!("{name}: {error:?}"));
            let variant = admitted["variant"].as_u64().unwrap() as usize;
            assert_eq!(guest.target, ["a", "b"][variant], "{name}");
            let timing = &admitted["timing"];
            assert_eq!(
                guest.timing,
                Timing {
                    tick_hz: timing["tickHz"].as_u64().unwrap() as u32,
                    cadence_hz: timing["cadenceHz"].as_u64().unwrap() as u32,
                },
                "{name}"
            );
        } else {
            let rejected = &case["rejected"];
            let Err(GuestError::NotAdmitted(mismatch)) = result else {
                panic!("{name}: admitted");
            };
            assert_eq!(mismatch.variant as u64, rejected["variant"].as_u64().unwrap(), "{name}");
            let items: Vec<&str> = ITEMS
                .iter()
                .filter(|(bit, _)| mismatch.items & bit != 0)
                .map(|(_, item)| *item)
                .collect();
            assert_eq!(items, strings(&rejected["items"]), "{name}");
            assert_eq!(
                mismatch.capability.as_str(),
                rejected["capability"].as_str().unwrap_or(""),
                "{name}"
            );
        }
    }
}
