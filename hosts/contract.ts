import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import type { PocketProfile } from "../contracts/spec/profile.ts";
import type { TargetProfile } from "../contracts/spec/platform-types.ts";

/** The resolver's view of a host contract: the display with its panel
 * sizes, under the shared binding generation. Software facts belong to the
 * document; the view keeps it as `source`. */
export function targetProfile<C extends string>(profile: PocketProfile<C>): TargetProfile<C> {
  const { display, panel } = profile;
  const auxiliary = display.auxiliary && panel.auxiliary
    ? { ...display.auxiliary, physicalViewport: panel.auxiliary } : undefined;
  return {
    cadences: profile.cadences,
    hostAbi: POCKET_BINDING_GENERATION,
    platform: profile.platform,
    form: profile.form,
    display: {
      physicalViewport: panel.primary,
      logicalViewports: display.logicalViewports,
      presentations: display.presentations,
      rasterDensity: display.rasterDensity,
      animation: display.animation,
      ...(display.dynamicViewport ? { dynamicViewport: display.dynamicViewport } : {}),
      ...(auxiliary ? { auxiliary } : {}),
    },
    capabilities: profile.capabilities,
    ...(profile.roleCapabilities ? { roleCapabilities: profile.roleCapabilities } : {}),
    source: profile,
  };
}

/** The document a view describes under `id`. The view's facts win over its
 * `source`, which supplies the runtime facts a view does not carry (worker
 * table, limits, input parameters). */
export function profileDocument<C extends string>(id: string, view: TargetProfile<C>): PocketProfile<C> {
  const { display } = view;
  const source = view.source;
  const auxiliary = display.auxiliary
    ? { logicalViewports: display.auxiliary.logicalViewports, presentations: display.auxiliary.presentations, rasterDensity: display.auxiliary.rasterDensity }
    : undefined;
  return {
    format: "pocket-host/2",
    id,
    platform: view.platform,
    form: view.form,
    cadences: view.cadences,
    display: {
      logicalViewports: display.logicalViewports,
      presentations: display.presentations,
      rasterDensity: display.rasterDensity,
      animation: display.animation,
      ...(display.dynamicViewport ? { dynamicViewport: display.dynamicViewport } : {}),
      ...(auxiliary ? { auxiliary } : {}),
    },
    panel: { primary: display.physicalViewport, ...(display.auxiliary ? { auxiliary: display.auxiliary.physicalViewport } : {}) },
    capabilities: view.capabilities,
    ...(view.roleCapabilities ? { roleCapabilities: view.roleCapabilities } : {}),
    ...(source?.worker ? { worker: source.worker } : {}),
    ...(source?.limits ? { limits: source.limits } : {}),
    ...(source?.input ? { input: source.input } : {}),
  };
}
