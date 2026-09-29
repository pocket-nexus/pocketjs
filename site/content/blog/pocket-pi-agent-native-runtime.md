<svg viewBox="0 0 760 440" width="100%" role="img" aria-label="A Pocket Pi App has two actor-specific surfaces over one shared architecture. A human uses a fixed View and UI intents. Pi Agent uses public Tools. Both invoke the same actor-neutral Actions, which read or change App-owned SQLite data. A committed revision causes the View to query a bounded projection of that data, while the Agent receives a structured result." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="440" rx="12" fill="#0b0f1a"/>
  <text x="24" y="32" fill="#94a3b8" font-size="12">one App · two actors · one durable truth</text>
  <text x="116" y="63" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Human</text>
  <text x="644" y="63" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Pi Agent</text>
  <rect x="16" y="78" width="728" height="338" rx="12" fill="#0e1626" stroke="#334155" stroke-width="1.5"/>
  <text x="36" y="103" fill="#64748b" font-size="11">APP RELEASE</text>
  <rect x="34" y="122" width="220" height="68" rx="10" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="144" y="148" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Fixed View</text>
  <text x="144" y="169" fill="#94a3b8" font-size="11" text-anchor="middle">human surface · UI intents</text>
  <rect x="506" y="122" width="220" height="68" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="616" y="148" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Public Tools</text>
  <text x="616" y="169" fill="#94a3b8" font-size="11" text-anchor="middle">Agent surface · typed calls</text>
  <line x1="116" y1="68" x2="116" y2="122" stroke="#475569" stroke-width="1.5"/>
  <line x1="644" y1="68" x2="644" y2="122" stroke="#475569" stroke-width="1.5"/>
  <rect x="278" y="208" width="204" height="72" rx="10" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="235" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Action</text>
  <text x="380" y="256" fill="#94a3b8" font-size="11" text-anchor="middle">actor-neutral domain operation</text>
  <text x="380" y="271" fill="#64748b" font-size="10" text-anchor="middle">validate · normalize · transact</text>
  <line x1="190" y1="190" x2="298" y2="222" stroke="#475569" stroke-width="1.5"/>
  <line x1="570" y1="190" x2="462" y2="222" stroke="#475569" stroke-width="1.5"/>
  <text x="235" y="211" fill="#64748b" font-size="10" text-anchor="middle">intent</text>
  <text x="525" y="211" fill="#64748b" font-size="10" text-anchor="middle">Tool call</text>
  <rect x="278" y="316" width="204" height="70" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="380" y="344" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">App-owned SQLite</text>
  <text x="380" y="365" fill="#94a3b8" font-size="11" text-anchor="middle">one durable truth</text>
  <line x1="380" y1="280" x2="380" y2="316" stroke="#475569" stroke-width="1.5"/>
  <text x="411" y="302" fill="#64748b" font-size="10">COMMIT</text>
  <rect x="34" y="316" width="196" height="70" rx="10" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="132" y="344" fill="#f1f5f9" font-size="12" text-anchor="middle">bounded projection</text>
  <text x="132" y="365" fill="#94a3b8" font-size="10" text-anchor="middle">revision changed? → query</text>
  <line x1="278" y1="351" x2="230" y2="351" stroke="#475569" stroke-width="1.5"/>
  <line x1="132" y1="316" x2="132" y2="190" stroke="#475569" stroke-width="1.5"/>
  <text x="145" y="300" fill="#64748b" font-size="10">read</text>
  <rect x="530" y="316" width="172" height="70" rx="10" fill="#111827" stroke="#64748b" stroke-width="1.5"/>
  <text x="616" y="344" fill="#f1f5f9" font-size="12" text-anchor="middle">structured result</text>
  <text x="616" y="365" fill="#94a3b8" font-size="10" text-anchor="middle">returned to the Agent surface</text>
  <line x1="530" y1="333" x2="482" y2="267" stroke="#475569" stroke-width="1.5"/>
</svg>

The [first Pocket Pi port](/blog/pocket-pi-on-esp32-p4/) proved that a complete Pi coding agent could live on an ESP32-P4: its loop, tools, schedules, workspace and interface all ran on the board rather than behind a remote screen. That proof had one deliberate shortcut. The Agent ran in QuickJS, but much of the product around it still lived in Rust firmware. Adding a new product meant teaching firmware about its Tools, state, refresh behavior and screen.

When I started turning Pocket Pi into my trading agent, I realized the next question was not how to weld more Apps onto the system. It was more fundamental: **what should an App be when both a human and an Agent can act on it?** Our answer was a firmware-independent product unit that owns its Data, Actions and View.

A traditional App assumes one primary operator—the human at its interface. An Agent is then forced either to imitate that operator through pixels and clicks, or to use a second API path whose state and business rules can drift away from the interface. We wanted one App that both actors could use, that the Agent could help evolve as the human's needs changed, and that still fit a 32 MB device. The answer in [**Pocket Pi PR #11**](https://github.com/pocket-nexus/pocket-pi/pull/11) is the subject of this post.

## Explaining the App Design Architecture

We started from three facts rather than from a framework.

First, **a human and an Agent express intent differently**. A human clicks a button, edits a form and reads a chart. An Agent works best with typed names, structured arguments and machine-readable results. Making the Agent operate the View through computer use preserves access to legacy software, but it throws away the semantics the App already knows. One domain operation becomes a loop of screenshots, target detection, clicks, waits and visual guesses.

Second, **both actors are operating the same product**. If the View implements one refresh path and a Tool implements another, there are now two sets of validation, two error models and eventually two versions of reality.

Third, **the product must outlive either actor's current session**. An Agent's work can finish while the View is closed, and a human can open the App after a reboot. A component tree, a chat transcript or a Tool result cannot be the durable destination of that work.

Those facts give us a compact definition:

```text
App = Data + Actions + View
```

**Data** is what the App remembers. **Actions** are the bounded operations the App can perform. The **View** is the projection that lets a human understand and act on the Data. Tools and UI intents are not competing implementations of the product; they are actor-specific surfaces over the same Actions.

### Data: what the App remembers

Every ordinary App owns a SQLite database. It is the durable truth behind both the human View and the Agent-facing Tool surface—not a dump of every provider response and not a cache of the current screen. Its schema stores the product facts that both actors need to share, rather than the transport that happened to produce them.

SQLite matters here for reasons larger than convenience. An action can commit while its View is in the background, survive a restart, and be inspected or migrated by a later App release. The same state can support a small embedded screen, a macOS simulator and a future device layout without asking the network or the Agent to reconstruct it.

Data is isolated by ownership. PocketJS gives each ordinary App a filesystem mount rooted at its own data directory, and its SQLite file lives inside that mount. The App has no path that names another App's database. Pi Agent owns the wider `/workspace`, but raw SQL into another App is not the application contract. System authority is exercised through the App's declared Tools, so the App remains the owner of its invariants and schema.

### Actions: the behavioral boundary of an App

Once a human and an Agent have different surfaces over the same Data, a new problem appears. If a button handler writes the database one way and a Tool writes it another way, the App has two implementations of its behavior. Validation, permissions, retries and state transitions can disagree even though both actors believe they are performing the same operation.

That is why the App needs **Actions**. An Action is one bounded, actor-neutral operation over App Data. It owns the rules and side effects required to take the App from one valid state to another: validate the intent, use any required provider capability, normalize the result, commit one SQLite transaction and publish the new revision. It does not care whether the intent came from a human interaction or an Agent Tool.

The surfaces still remain different. A UI intent can carry navigation context and produce a loading state. A Tool has a typed schema and returns a structured result. Those actor-specific details end at the Action boundary; the product behavior is implemented once.

Consider the **Refresh Now** button in the Robinhood App. The human taps it in the View. Pi Agent calls the typed `robinhood.refresh_portfolio` Tool. The AgentOS Tool Router routes that Tool call back to the Robinhood App, where both entrances invoke the same `refreshPortfolio` Action. That Action fetches the provider state, normalizes the portfolio, commits SQLite and publishes an App revision.

<img class="w-full rounded-xl border border-line" src="/assets/blog/pocket-pi-agentos-robinhood-refresh-action.png" alt="The Robinhood Refresh Now UI intent and the robinhood.refresh_portfolio Agent Tool converging on the same refreshPortfolio Action, which fetches provider state, normalizes portfolio data, commits an App-owned SQLite transaction and publishes an App revision." />

<p class="mt-2 text-center text-sm text-slate-500"><code>REFRESH NOW</code> and <code>robinhood.refresh_portfolio</code> are different surfaces over the same <code>refreshPortfolio</code> Action.</p>

Once an Action is independent of its caller, a local Schedule can invoke it too without adding another product implementation or waking the model.

#### Why the Agent does not access SQLite directly

SQLite is a storage representation, not a capability boundary. A table tells us how facts are stored; it does not tell us which state transitions are legal. Giving the Agent arbitrary SQL would let a runtime call bypass the App's validation, permissions, confirmation rules, idempotency and revision protocol. It would also couple every Agent call to a private schema that the next App release may migrate.

System-wide authority does not require raw storage authority. In normal operation, Pi Agent receives the public Tool; the Tool Router selects the owning App; the Action protects that App's invariants; and SQLite remains private implementation. The Agent can use the full capability the App intentionally exposes without being able to place the database into a state the App does not understand.

#### The boundary that enables App evolution

This restriction is also what makes broad Agent authorship safe. We separate **operating an App** from **changing the App**. During operation, the Agent invokes bounded Tools and never improvises SQL. During evolution, it can produce a complete versioned change: adjust the Tool surface, change the Action implementation, add a schema migration and update the View projection together. The human provides the requirement and approves the resulting release.

Because behavior is centralized in Actions, the Agent can tune a Tool after observing real use, refactor the underlying tables without exposing that migration to callers, and preserve one set of invariants for the View, Tools and Schedules. Bounded operation and whole-App evolution are not opposing ideas. The bounded runtime surface is what makes it possible to let the Agent safely change the larger system behind it.

### Views: how the Data becomes legible to a human

A View is a bounded projection of App Data. It owns layout, navigation and transient interaction state; it does not own the provider call or the durable product truth. “Fixed View” means fixed for one App release, not hardcoded in firmware. The Agent does not regenerate it on every turn, so the human gets a stable interface that can be designed, tested and optimized for the device.

After an Action commits, the runtime increments a small per-App revision. If that App is in the foreground, its View notices that the committed revision is newer, runs one bounded SQLite query, updates its memory cache and renders. If the App is closed, it performs no View work. When it opens later, it projects the latest state once.

The revision is invalidation, not another copy of the Data. The Agent never calls `update_view`, and a Data Action never pushes presentation into a component tree. That would create a second synchronization protocol that had to survive navigation, background execution, Schedules and reboot. Instead, every screen is reconstructed from durable state.

Navigation follows the same boundary. Moving between pages changes which projection the human sees. It does not decide whether the App's Data exists, whether its Schedule can run, or whether Pi Agent can call its Tools.

### The complete App becomes evolvable

Once Data, Actions and the View belong to one release, changing the product no longer has to cross the firmware boundary. The Agent can adjust the Tool surface, change an Action, migrate the schema and update the View projection as one coherent App revision. The human provides the requirement and final approval; the App turns the result into durable behavior.

Today the ESP32 executes prebuilt bundles rather than compiling arbitrary TSX on-device, so validation, activation and rollback remain explicit system responsibilities. The important boundary is already in place: the complete product change is App-local, and firmware does not need to learn what that product means.

## From one App to an ecosystem

Once every App owns its Data, Actions and View, adding another product becomes a composition problem rather than a firmware problem. The runtime only needs common contracts for ownership, lifecycle and routing; it does not need to understand each product it hosts.

<svg viewBox="0 0 760 420" width="100%" role="img" aria-label="Pocket Pi AgentOS architecture. A resident Pi Agent System App owns the workspace and uses an App Tool Router to work with Exa and Robinhood Apps. Each App contains Tools, Data Actions, SQLite state and a fixed PocketJS View. PocketJS UI, net, fs and db modules connect those Apps to macOS or ESP32-P4 host adapters." font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="0" y="0" width="760" height="420" rx="12" fill="#0b0f1a"/>
  <text x="24" y="34" fill="#94a3b8" font-size="12">Pocket Pi AgentOS — one resident Agent, many isolated Apps</text>
  <rect x="218" y="52" width="324" height="76" rx="10" fill="#111827" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="380" y="78" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Pi Agent · resident System App</text>
  <text x="380" y="99" fill="#94a3b8" font-size="11" text-anchor="middle">Agent Loop + Root View · owns /workspace</text>
  <text x="380" y="116" fill="#94a3b8" font-size="11" text-anchor="middle">keeps running while another App is foreground</text>
  <line x1="380" y1="128" x2="380" y2="158" stroke="#475569" stroke-width="1.5"/>
  <rect x="246" y="158" width="268" height="48" rx="9" fill="#111827" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="380" y="179" fill="#f1f5f9" font-size="12" text-anchor="middle">App Supervisor · Tool Router</text>
  <text x="380" y="196" fill="#94a3b8" font-size="10" text-anchor="middle">lifecycle · schedules · revisions · ownership</text>
  <line x1="300" y1="206" x2="190" y2="236" stroke="#475569" stroke-width="1.5"/>
  <line x1="460" y1="206" x2="570" y2="236" stroke="#475569" stroke-width="1.5"/>
  <rect x="24" y="236" width="332" height="92" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="190" y="260" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Exa App</text>
  <text x="190" y="282" fill="#94a3b8" font-size="11" text-anchor="middle">Tools → Actions → SQLite</text>
  <text x="190" y="302" fill="#94a3b8" font-size="11" text-anchor="middle">fixed research View · bounded history</text>
  <text x="190" y="319" fill="#64748b" font-size="10" text-anchor="middle">fetch() through PocketJS NET</text>
  <rect x="404" y="236" width="332" height="92" rx="10" fill="#111827" stroke="#34d399" stroke-width="1.5"/>
  <text x="570" y="260" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Robinhood App</text>
  <text x="570" y="282" fill="#94a3b8" font-size="11" text-anchor="middle">Tools → Actions → SQLite</text>
  <text x="570" y="302" fill="#94a3b8" font-size="11" text-anchor="middle">fixed portfolio View · local Schedule</text>
  <text x="570" y="319" fill="#64748b" font-size="10" text-anchor="middle">MCP through native credential boundary</text>
  <line x1="190" y1="328" x2="190" y2="350" stroke="#475569" stroke-width="1.5"/>
  <line x1="570" y1="328" x2="570" y2="350" stroke="#475569" stroke-width="1.5"/>
  <rect x="24" y="350" width="712" height="46" rx="9" fill="#111827" stroke="#a78bfa" stroke-width="1.5"/>
  <text x="380" y="371" fill="#f1f5f9" font-size="12" text-anchor="middle">PocketJS modules · UI · NET · FS · DB</text>
  <text x="380" y="388" fill="#94a3b8" font-size="10" text-anchor="middle">portable contracts → macOS simulator or ESP32-P4 host adapters</text>
</svg>

The diagram follows directly from that rule. Ordinary Apps own product meaning. AgentOS owns the catalog, Tool routing and lifecycle. PocketJS and the native Host implement the UI, database, filesystem and network contracts once. A new App can therefore be developed by answering three questions: what Data does it own, what Actions can change that Data, and how should its View project the result to a human?

The current build composes prebuilt Apps at build time. A future Marketplace will need admission, signatures, capability review and rollback, but those mechanisms can evolve without changing the App model itself.

### Pi Agent as the System App

A multi-App runtime needs one coordinator that can translate a human goal into work across Apps. That work can outlive whichever View is on screen, so the Agent's lifecycle cannot be tied to foreground navigation. This is why Pi Agent is a resident System App: it owns `/workspace`, sees the cross-App Tool Catalog and keeps running while the human moves between Views.

Its wider scope does not dissolve App boundaries. Pi Agent composes each App's public Tools rather than reaching into private tables. The human provides needs and approval, the Agent interprets and coordinates them, and Apps preserve the outcome as durable state and behavior.

### Why this still fits the board

The same boundaries also fit the board. Actions run outside the View's frame loop, foreground Views query bounded projections only when their revision changes, and background Apps perform no rendering work. PocketJS keeps the App contracts portable while the Host retains display, storage, credentials, transport and resource limits.

## What this makes possible

The first Pocket Pi proved that an Agent could live on embedded hardware. This App architecture gives that Agent a clear software environment to live among.

For an App author, the development model is explicit: define the Data, implement the Actions, expose the appropriate Tools and project the result through a View. AgentOS supplies isolation, routing and lifecycle; the Host supplies hardware mechanisms. New product behavior does not require another firmware-specific screen, provider integration or state path.

For Pi Agent, every admitted App adds a bounded set of capabilities it can understand, compose and eventually help evolve. For the human, those capabilities remain visible through stable Views and governed by explicit approval. More Apps expand what the system can do without expanding the trusted firmware with each product.

That is the path from one embedded Agent to a Pocket Pi ecosystem: independent Apps with a simple development boundary, one resident Agent that can coordinate them, and a runtime that can grow the catalog without having to redefine what an App is each time.
