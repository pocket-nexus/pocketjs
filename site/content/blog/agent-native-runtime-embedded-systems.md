The [previous Pocket Pi post](/blog/pocket-pi-agent-native-runtime/) established the App model we wanted humans and Agents to share:

```text
App = Data + Actions + View
```

Based on that model, we next made ordinary Apps hot-pluggable. A `.pocketapp` could arrive over the local network or UART, be reviewed and activated while Pocket Pi was running, then be uninstalled without rebuilding or reflashing Firmware.

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-pi-hotplug-install-flow.png" alt="Three Pocket Pi ESP32-P4 Simulator states side by side: an empty optional App catalog, review of the Exa Research package and the Apps screen after Exa has been installed at runtime." />

<p class="mt-2 text-center text-sm text-slate-500">Empty catalog → package review → Exa installed in the running system.</p>

This is runtime hot-plugging, not in-place replacement or App revision: installation is create-only, and an installed App must be uninstalled before the same id can be installed again.

But hot-plugging exposed an architectural asymmetry. An App could now enter and leave the running system independently of Firmware, while the software inside that App was still compiled elsewhere and common App policy was still split across native Rust and App-specific Bundles. Making the lifecycle dynamic encouraged us to rethink the layers that defined the App itself.

## The architecture before this refactor

An ordinary App was independent as a release, but that release was still built elsewhere:

```text
.pocketapp
├── agent-app.json
├── pocket.json
├── plan.json
├── app.js          precompiled View Bundle
├── app.pak         generated UI resources
├── data-action.js  precompiled behavior Bundle
└── credentials.json
```

The board needed no Node, Bun or Cargo to execute this Bundle, but changing `app.js` or `data-action.js` still required those tools off-device. The system looked like this:

<div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
<svg viewBox="0 0 760 590" width="100%" style="display: block; min-width: 680px;" role="img" aria-label="Pocket Pi architecture before the refactor. Hardware sits below a native Firmware host. Firmware owns both protected mechanisms and App or System policy. PocketJS is the only JavaScript substrate. A resident precompiled Pi Agent Bundle and separate precompiled ordinary View and Data Action Bundles execute in isolated Guests. SQLite remains durable, but common App policy is split between native Rust and the Bundles." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="590" rx="12" fill="#0b0f1a"/>
  <text x="24" y="30" fill="#94a3b8" font-size="12">Before · one PocketJS substrate · precompiled Bundles · split policy</text>

  <rect x="24" y="48" width="712" height="50" rx="9" fill="#111827" stroke="#64748b" stroke-width="1.5"/>
  <text x="380" y="78" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Hardware</text>

  <rect x="24" y="112" width="712" height="150" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="380" y="138" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Firmware / Native Host · Rust + C</text>

  <rect x="44" y="152" width="316" height="88" rx="8" fill="#0e1626" stroke="#64748b"/>
  <text x="202" y="176" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">Protected mechanisms</text>
  <text x="202" y="198" fill="#94a3b8" font-size="10.5" text-anchor="middle">drivers · credentials · storage roots</text>
  <text x="202" y="216" fill="#64748b" font-size="10" text-anchor="middle">Guest lifecycle · limits · package validation</text>

  <rect x="380" y="152" width="336" height="88" rx="8" fill="#21131b" stroke="#fb7185"/>
  <text x="548" y="176" fill="#fecdd3" font-size="11.5" font-weight="700" text-anchor="middle">App / System policy in Native Rust</text>
  <text x="548" y="198" fill="#fda4af" font-size="10.5" text-anchor="middle">AppSupervisor · ViewRuntime · DataActionRunner</text>
  <text x="548" y="216" fill="#9f6b76" font-size="10" text-anchor="middle">dispatch · Projection refresh · View lifecycle</text>

  <rect x="24" y="276" width="712" height="58" rx="10" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="380" y="302" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PocketJS Runtime Platform · Rust + QuickJS C</text>
  <text x="380" y="322" fill="#94a3b8" font-size="10.5" text-anchor="middle">the device's only JavaScript execution substrate</text>
  <text x="380" y="354" fill="#fb7185" font-size="10.5" font-weight="700" text-anchor="middle">common App policy split across Native Manager ↕ precompiled Bundles</text>

  <rect x="24" y="368" width="340" height="138" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="194" y="395" fill="#f1f5f9" font-size="12.5" font-weight="700" text-anchor="middle">Pi Agent · resident System Bundle</text>
  <text x="194" y="418" fill="#94a3b8" font-size="10.5" text-anchor="middle">1 isolated System Guest</text>
  <line x1="54" y1="434" x2="334" y2="434" stroke="#1e293b"/>
  <text x="194" y="458" fill="#f1f5f9" font-size="11.5" text-anchor="middle">agent.js · app.js · app.pak</text>
  <text x="194" y="482" fill="#64748b" font-size="10" text-anchor="middle">Chat · Files · Apps · Settings</text>

  <rect x="380" y="368" width="356" height="64" rx="10" fill="#171521" stroke="#fb7185" stroke-width="1.5"/>
  <text x="558" y="391" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">Precompiled View Bundles · LRU ≤ 3</text>
  <text x="558" y="410" fill="#94a3b8" font-size="10" text-anchor="middle">app.js + app.pak · App-specific DB plumbing</text>
  <text x="558" y="425" fill="#64748b" font-size="8.5" text-anchor="middle">Adjustable Based on Hardware</text>

  <rect x="380" y="442" width="356" height="64" rx="10" fill="#171521" stroke="#fb7185" stroke-width="1.5"/>
  <text x="558" y="465" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">Precompiled Data Action Bundles · LRU ≤ 3</text>
  <text x="558" y="484" fill="#94a3b8" font-size="10" text-anchor="middle">data-action.js · private invocation plumbing</text>
  <text x="558" y="499" fill="#64748b" font-size="8.5" text-anchor="middle">Adjustable Based on Hardware</text>

  <rect x="24" y="520" width="712" height="40" rx="9" fill="#0e1626" stroke="#34d399" stroke-width="1.5"/>
  <text x="380" y="545" fill="#f1f5f9" font-size="12" text-anchor="middle">App-owned SQLite + files · durable across Guest eviction and restart</text>
</svg>
</div>

This was already a meaningful architecture. It had one PocketJS substrate, isolated Guests, a resident Pi Agent, separate 3+3 LRUs and durable App Data. The problem is highlighted in pink: the layer that should have been a shared System Framework was split between native classes and App-specific bundle plumbing.

The refactor therefore does not add another Runtime or replace the Guest model. It preserves PocketJS, isolation, bounded caches and SQLite, while extracting shared product policy into one explicit JavaScript layer.

That exposed three ownership problems at once. “Runtime” was being used for the PocketJS execution platform, each isolated QuickJS Guest and the complete Pocket Pi product environment. The System Framework existed as behavior, but not yet as a clean JavaScript layer. And there was no honest release boundary on which to build App revision, migration or rollback.

Pocket Pi therefore remains create-only today: installing an existing App id fails. Adding replacement first would only version the precompiled boundary we intend to remove.

The refactor in [**Pocket Pi PR #14**](https://github.com/pocket-nexus/pocket-pi/pull/14) starts below replacement. It defines which layer owns execution, policy, isolation and product meaning, so the eventual revision protocol can manage the right software unit.

## Deriving the system from first principles

First principles here are not framework names or current cache sizes. They are the smallest requirements from which the layers follow. We arrived at three.

### 1. Protected mechanism below; evolvable business above

The first question is where authority must live and where change must be cheap.

**Rust and C express protected mechanisms:** hardware drivers, Guest creation and destruction, memory and deadline enforcement, capability checks, credential handling, storage isolation, transport, package admission and recovery. A mechanism defines what the machine can do safely and enforces what no App is allowed to override.

**JavaScript expresses business and product policy:** an App's Actions, Data rules and View; plus Projection binding, navigation, shared components and App-facing APIs in the System Framework. This layer defines what the product does for a person or Agent. It needs to be inspectable and quick to iterate without rebuilding and reflashing Firmware.

The boundary is not based on the idea that Rust cannot express business logic or that JavaScript should touch hardware directly. It follows **authority, rate of change and failure radius**. A JavaScript Wi-Fi request still crosses a native capability check. A navigation rule does not become a hardware mechanism merely because it was once implemented in Rust.

This produces a stability gradient. Security-sensitive enforcement remains small, native and auditable. Actions, screens and workflows can evolve in JavaScript. A new board can replace drivers and its device profile while reusing the same business layer.

### 2. Build a bounded Guest system on one PocketJS substrate

Once PocketJS can execute JavaScript, the next question is not which second Runtime to place above it. It is how to host multiple Apps with isolation, independent lifecycles and durable state on a memory-constrained device.

PocketJS/QuickJS remains the single JavaScript execution substrate. On top of it, the native Runtime Manager creates Guests. Each Guest combines an isolated QuickJS runtime and context with one App identity, a capability set, filesystem and SQLite roots, and a bounded lifecycle. A Guest is therefore an isolated execution instance created by PocketJS—not another JavaScript platform and not a service sharing one global heap.

The Runtime Manager keeps one resident Pi Agent System Guest outside two independent ordinary-App caches:

```text
1 resident Pi Agent System Guest
+ up to 3 ordinary View Guests    (adjustable based on hardware)
+ up to 3 ordinary Action Guests  (adjustable based on hardware)
= up to 7 isolated Guests
```

A visible App may not have an Action Guest until somebody invokes an Action. A closed App may retain a recent Action Guest for a Schedule or Tool. Navigation never evicts Pi Agent.

View and Action Guests use separate pools because their lifecycles are different: a View follows visibility, while an Action may be invoked independently by UI, Pi Agent or a Schedule. The pools bound concurrency and memory without coupling those lifecycles.

The cache sizes are resource parameters, not architecture. The invariant is that execution is isolated, bounded and disposable while App truth is durable. SQLite and App-owned files live outside Guest heaps, so eviction changes memory use without changing product state. This is the Guest system Pocket Pi builds on top of PocketJS.

### 3. An Agent-native App must be operable and evolvable by the Agent

If Agent-native meant only that a model could call a few Tools, the architecture could stop at App operation. Our stronger requirement is that Pi Agent should operate installed Apps through their public behavior and eventually evolve complete Apps through the same public authoring contract available to a developer.

At the operation boundary, a Tool call, a button press and a Schedule wake are different sources of intent—not different business runtimes:

```json
{"action":"refreshPortfolio","args":{},"source":"tool|ui|schedule"}
```

The source can affect confirmation policy or the returned surface, but the domain transition is one Action: validate, call an admitted provider capability, normalize, transact and return a result. This preserves one set of App invariants whether the initiator is a person, Pi Agent or a clock.

At the evolution boundary, the unit the Agent edits is the whole App:

```text
App = Data + Actions + View
```

The Agent must be able to read and modify App source against a stable SDK instead of depending on native internals or an off-device bundler. Operation and evolution still carry different authority: calling an admitted Action is normal use, while changing Data rules, Actions or View creates a candidate release. That candidate must be loaded in isolated Guests, validated as one unit and promoted explicitly before it becomes active.

This is why the SDK is not merely a convenience wrapper. It is the shared, machine-readable authoring boundary for developers and Pi Agent, while the JavaScript System Framework is its device-side implementation. It is also why source loading and revision are one future capability rather than unrelated features.

These principles produce the architecture directly: a Native Host for mechanisms, a JavaScript System Framework for evolvable business policy, a bounded Guest system on PocketJS for execution, and one App SDK for both human and Agent authorship.

Linux and Android are useful only as boundary analogies: protected mechanisms sit below independently evolving framework and system software. Pocket Pi follows that separation instinct, but its isolation unit is a bounded QuickJS Guest, its durable App truth is local SQLite and its total memory budget may be 32 MB. Copying a desktop process model or Android framework would solve the wrong problem.

## The new architecture

<div style="overflow-x: auto; -webkit-overflow-scrolling: touch;">
<svg viewBox="0 0 760 590" width="100%" style="display: block; min-width: 680px;" role="img" aria-label="Pocket Pi Agent-native Runtime architecture. Hardware sits beneath a native Firmware host that owns drivers, credentials, security and bounded lifecycle. PocketJS is the single JavaScript execution platform. A pure-JavaScript Pocket Pi System Framework is evaluated inside each Guest. The App layer contains one resident Pi Agent System Guest with Agent Loop and Chat, Files, Apps and Settings, plus independent three-entry ordinary View and Action Guest caches. App-owned SQLite data survives Guest eviction." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="590" rx="12" fill="#0b0f1a"/>
  <text x="24" y="30" fill="#94a3b8" font-size="12">Pocket Pi · one substrate · bounded Guests · durable Apps</text>

  <rect x="24" y="48" width="712" height="50" rx="9" fill="#111827" stroke="#64748b" stroke-width="1.5"/>
  <text x="380" y="78" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Hardware</text>

  <rect x="24" y="112" width="712" height="88" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="380" y="139" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Firmware / Native Host · Rust + C</text>
  <text x="380" y="163" fill="#94a3b8" font-size="11" text-anchor="middle">drivers · credentials · capability enforcement · storage roots · deadlines</text>
  <text x="380" y="181" fill="#64748b" font-size="10" text-anchor="middle">AppSupervisor · package validation · bounded Guest lifecycle · rendering</text>

  <rect x="24" y="214" width="712" height="64" rx="10" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="380" y="241" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">PocketJS Runtime Platform · Rust + QuickJS C</text>
  <text x="380" y="262" fill="#94a3b8" font-size="11" text-anchor="middle">the device's only JavaScript execution substrate</text>

  <rect x="24" y="292" width="712" height="72" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="319" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Pocket Pi JS System Framework / SDK</text>
  <text x="380" y="341" fill="#94a3b8" font-size="11" text-anchor="middle">Actions · Projection · View components · navigation · App-facing APIs</text>
  <text x="380" y="357" fill="#64748b" font-size="10" text-anchor="middle">evaluated inside every Guest · not an App · not another Guest</text>

  <rect x="24" y="378" width="340" height="140" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="194" y="405" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Pi Agent · System App</text>
  <text x="194" y="428" fill="#94a3b8" font-size="11" text-anchor="middle">1 resident System Guest</text>
  <line x1="54" y1="444" x2="334" y2="444" stroke="#1e293b"/>
  <text x="194" y="468" fill="#f1f5f9" font-size="12" text-anchor="middle">Agent Loop</text>
  <text x="194" y="492" fill="#94a3b8" font-size="11" text-anchor="middle">Chat · Files · Apps · Settings</text>
  <text x="194" y="509" fill="#64748b" font-size="10" text-anchor="middle">privileged · never in either LRU</text>

  <rect x="380" y="378" width="356" height="66" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="558" y="400" fill="#f1f5f9" font-size="12.5" font-weight="700" text-anchor="middle">Ordinary View Guests · LRU ≤ 3</text>
  <text x="558" y="419" fill="#94a3b8" font-size="10.5" text-anchor="middle">fixed View for the selected App release</text>
  <text x="558" y="436" fill="#64748b" font-size="8.5" text-anchor="middle">Adjustable Based on Hardware</text>

  <rect x="380" y="452" width="356" height="66" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="558" y="474" fill="#f1f5f9" font-size="12.5" font-weight="700" text-anchor="middle">Ordinary Action Guests · LRU ≤ 3</text>
  <text x="558" y="493" fill="#94a3b8" font-size="10.5" text-anchor="middle">Tool · UI · Schedule → the same Actions</text>
  <text x="558" y="510" fill="#64748b" font-size="8.5" text-anchor="middle">Adjustable Based on Hardware</text>

  <rect x="24" y="532" width="712" height="38" rx="9" fill="#0e1626" stroke="#34d399" stroke-width="1.5"/>
  <text x="380" y="556" fill="#f1f5f9" font-size="12" text-anchor="middle">App-owned SQLite + files · durable across Guest eviction and restart</text>
</svg>
</div>

This is a stack of ownership boundaries, not a stack of JavaScript engines.

### Native Host: mechanism and final authority

Firmware contains the board-specific Rust and C that initializes hardware and embeds PocketJS. The Runtime Manager and `AppSupervisor` stay here because somebody outside every Guest must create and destroy Guests, enforce deadlines and memory limits, isolate storage, gate credentials, validate packages and recover from failure.

Native can expose narrow primitives for display, input, network, SQLite, files and device operations. It remains the final authority over those primitives. It does not own App navigation, business Actions or View composition.

### PocketJS: the single JavaScript substrate

PocketJS is the only JavaScript execution platform on the device. It integrates QuickJS with the modules and host bindings required by embedded Apps. When Pocket Pi asks for a Guest, PocketJS creates an isolated QuickJS runtime and context; Pocket Pi does not place another engine above it.

This distinction matters. PocketJS owns how JavaScript executes. Pocket Pi owns why a Guest exists, which App release it belongs to and when it may be evicted.

### Pocket Pi JS System Framework: shared policy and SDK

The new layer is a platform-owned JavaScript package evaluated inside each View and Action Guest before App code. It defines the common App contract:

```js
PocketPi.defineActions({ refreshPortfolio, search, fetch });
PocketPi.defineView({ update, tap, tick });
PocketPi.action("refreshPortfolio", {});
PocketPi.projection.one(sql, params, apply);
PocketPi.projection.many(sql, params, apply);
PocketPi.data.transaction(() => { /* App-owned writes */ });
```

It is not another Guest, another runtime or a parent App. It consumes no additional LRU slot. It is pure JavaScript because Actions, Projection binding, View components, navigation and App-facing APIs are editable system policy. They should be inspectable by the same runtime that executes Apps and should not require a Firmware rebuild to evolve.

The private `PocketPiSystem` ABI points in the opposite direction. The native Runtime Manager uses it to configure a Guest, begin and poll an Action, refresh Projection bindings and dispatch View input. Ordinary App code uses the public `PocketPi` SDK; it does not gain native authority by reaching into the private ABI.

### Apps: one layer, different trust and lifecycle

The [previous post](/blog/pocket-pi-agent-native-runtime/) defined the App model itself. The architectural point here is only that Pi Agent and ordinary Apps occupy the same App layer with different trust and lifecycle. Pi Agent is the resident, platform-owned System App outside both LRUs; Exa, Robinhood and future installable Apps use isolated, evictable View and Action Guests. Pi Agent may launch or operate an ordinary App, but the App is never nested inside its JavaScript heap.

### Data: durable outside the Guest

As described previously, SQLite and App-owned files are the durable product truth, while Projection only binds Data into a View. For this architecture, the essential property is that Guests are disposable execution state: evicting a View or Action Guest never evicts the App, and reopening it reconstructs execution from durable Data.

The immediate result is a thinner Firmware boundary and a real place for an App SDK. Adding a provider mapping, Action, Projection or screen no longer needs another native product path. The current Framework still ships inside Firmware, but its language, API and ownership boundary are now explicit; independent delivery can be added later without first untangling policy from Rust.

## Next steps

The roadmap now has three broader milestones.

### 1. Source-native Apps that Pi Agent can evolve safely

Source loading, Agent iteration and App revision are one product capability: **the device can understand, validate and promote the App's real unit of change.**

A `.pocketapp` can remain the transport container while its executable content becomes App-local raw JavaScript:

```text
.pocketapp
├── app.json
├── pocket.json
├── src/actions.js
├── src/projection.js
├── src/view.js
└── assets/*
```

Actions become raw modules. Projection becomes a small validated binding declaration. View becomes a raw-JavaScript component tree built from shared components such as `Screen`, `Header`, `Section`, `List`, `Detail`, `Button` and `EmptyState`. Exa and Robinhood move to this contract, and the old ordinary Bundle entrypoints are deleted rather than preserved as a second path.

On that source boundary, Pi Agent can edit Actions, schema and View together, load the result into isolated validation Guests and preview it as a candidate. App revision then becomes the promotion protocol around that candidate: immutable active and candidate releases, schema migration, atomic activation and rollback while preserving App-owned Data.

Pocket Pi should remain create-only until this entire loop is coherent. Replacement built earlier would version the wrong artifact; revision built here protects the exact source unit the board and Agent understand.

### 2. Carry the same App model across hardware

The second milestone is a real non-ESP target and multiple screen profiles.

Each native Host should implement only its board's mechanisms and provide a small device profile: logical viewport, density, orientation, safe insets and bounded resource parameters. The JS component layer should translate semantic App Views into compact portrait, regular portrait or landscape layouts. Data and Actions should not know the board name.

We should extract only the host abstractions demonstrated by that second target. The goal is a narrow change surface—native drivers and device profile below, reusable Framework and Apps above—not a speculative universal embedded HAL.

### 3. Update System software independently from Firmware

After the ordinary App source and revision lifecycle is proven, the same release discipline can move upward.

The Pocket Pi JS System Framework and Pi Agent System App can become signed, versioned System releases with PocketJS ABI compatibility checks, candidate validation, atomic activation and recovery to a previous release. Firmware OTA remains available for PocketJS, native capabilities, drivers and security enforcement; a change to Chat, Settings, navigation or common App components no longer needs to be a Firmware update.

System OTA comes last because System software has more authority and a larger failure radius than an ordinary App. The ordinary App lifecycle should prove the source, validation and rollback primitives before they are trusted with the resident Agent and shared SDK.

An Agent-native runtime is not defined only by running a model loop locally. It is defined by an environment whose mechanisms are protected, whose policy is editable, whose Apps have durable ownership and whose source can be validated and evolved by the device itself.

The previous architecture gave Pi Agent a world of Apps it could operate. This refactor gives that world the layers it needs to become portable, revisable and eventually self-hosting.
