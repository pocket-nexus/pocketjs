There is a city running on the devices on my desk: a PSP, a Nintendo 3DS, a PS Vita, an iPod touch, and an Android phone. You can fly past Tokyo Tower, move the sun across the sky, and watch the streets light up at dusk.

Each device is running a native build of **Pocket Tokyo**, one of the first applications built with **Pocket3D**, our hardware-native 3D stack for portable interactive software.

The city comes from the same source. The programs drawing it are built around five very different machines.

<video class="w-full rounded-xl border border-line" width="1920" height="1080" controls playsinline preload="metadata" poster="/assets/blog/pocket3d-launch.jpg" aria-label="Evan introduces Pocket3D and Pocket Studio, with games running on real handhelds">
  <source src="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocket3d-launch-fd27894d.mp4" type="video/mp4" />
  <a href="https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/pocket3d-launch-fd27894d.mp4">Watch the Pocket3D launch film.</a>
</video>

Three months ago, we introduced [PocketJS](https://pocketjs.dev/blog/introducing-pocketjs/): modern component-based UI on devices that were never expected to run it. Solid and Vue components, styled with Tailwind classes, became native software on a PSP. More machines followed, along with applications and community ports.

Games pushed that work in another direction. [OpenStrike](https://pocketjs.dev/blog/shipping-openstrike/) needed visibility, collision, and a renderer for its maps. [Pocket Voxel](https://pocketjs.dev/blog/pocket-voxel/) needed a compiler that could turn tile data into a world the PSP could afford to draw. More recent projects needed rain, moving sunlight, crowded battlefields, and fast movement through a city.

Pocket3D brings that approach together: **a way to build the compiler and runtime a particular experience needs, for the hardware it will run on.**

## Let the machine shape the renderer

The PSP's Graphics Engine has a fixed pipeline. It can transform and texture geometry, apply lighting, blend vertices, and use palette textures. It has no programmable shaders.

The Nintendo 3DS has a different set of possibilities. Its PICA200 runs vertex programs and combines textures through a chain of configurable stages. The system also has two screens, touch input, and a glasses-free 3D display.

The Vita gives us programmable vertex and fragment processing through GXM, along with features such as multisampling. A renderer can spend that capacity on lighting and post-processing that would need a different treatment on the PSP.

These differences matter to the work we make. A scene's texture format, the way its geometry is grouped, and how its lights are represented can determine whether it fits at all.

In Pocket3D, each project's renderer can make those decisions for its target. Shared device code handles things such as allocating GPU memory, publishing textures, and keeping resources alive until the GPU has finished with them. Above that, the game owns its rendering strategy.

The most useful way to explain this is to follow one effect through three machines.

## The same sunlight, three implementations

Pocket Tokyo has a clock. As the sun moves, the buildings cast moving shadows over the city.

On the **Vita**, the renderer uses a texture of heights. A fragment program compares a surface's height with the stored value to decide whether it is shaded.

On the **3DS**, the compiler and renderer represent the shade as an 8-bit texture over the city. A PICA texture-combiner stage multiplies it into the surface color.

On the **PSP**, the answer is a palette. The upper half of each palette contains shadowed versions of the colors in the lower half. Updating the high bit of an index selects the shaded color. The fixed-function GPU can then draw the result.

All three implementations express the same idea: this part of the city is in shadow at this time of day. They use different data and different work to produce it.

This is why the source needs to preserve what the scene *means*. Pocket Tokyo has a project-specific representation called **CityIR**, which holds information about the city that its compilers can use. It gives each target enough information to choose its own implementation.

That is the portability we care about. The city and its behavior remain recognizable; the renderer is free to fit the machine.

## Three.js on the development machine

We use TypeScript and Three.js to create and preview many of these projects. They make a productive starting point: describe a world in code, open it in a browser, move around, and change it while you can see what you are doing.

The native build takes another path. A project's compiler reads its scene data, performs the work that can be done ahead of time, and produces a pack for a particular target. That can include baked lighting, visibility information, levels of detail, texture encodings, and vertex layouts. The device runs the corresponding native renderer.

For Pocket Atlas, that means a place can begin as a Three.js scene, be exported with information about its materials and effects, and become textures, vertices, and lighting data consumed by a renderer written for those places.

**The scene, compiler, and renderer are developed together.** The compiler understands the project's content contract; supporting another Three.js application can require new compiler passes and rendering code. Pocket3D provides the device mechanisms and working examples on which to build them.

It also leaves room for different authoring choices. A procedural world generator or a simulation can live in Rust and be shared between a browser build through WebAssembly and native device builds. Three.js is a useful creative environment; it does not have to own every part of a game.

## Different games need different engines

We have been developing several projects alongside Pocket3D because each one asks a different question.

**[Pocket Atlas](https://studio.pocket.nexus/games/atlas)** is about being in a place. A convenience store on a rainy night, a railway crossing, a view from an observatory. The work goes into materials, lighting, weather, and the details that make a small scene worth spending time in. Its compiler works with places and their rendering requirements.

**[Pocket Maneuver](https://studio.pocket.nexus/games/maneuver)** is about movement. Two wire hooks pull you through a walled town of roughly 5,400 houses. Its world needs collision, spatial organization, and levels of detail that hold up while the player travels through it at speed. Its simulation and rendering preparation are built around that movement.

**[Pocket Requiem](https://studio.pocket.nexus/games/requiem)** is about a crowded battlefield. Close characters and distant formations have different visual needs and different costs. On the smaller machines, detailed nearby meshes give way to inexpensive silhouettes at a distance, preserving the scale of the army within the rendering budget.

**[Pocket Tokyo](https://studio.pocket.nexus/games/tokyo)** is about a city changing through the day. Building data, road layouts, sunlight, shadows, and windows becoming illuminated give its compiler a different vocabulary again.

PlaceIR belongs to Atlas. WorldIR belongs to Maneuver. CityIR belongs to Tokyo. Each project can keep a representation that describes its own world well.

That ownership is part of Pocket3D's design. We share device mechanisms and reuse what has proved useful across projects, while keeping scene semantics and rendering decisions close to the experience that needs them. A battlefield does not have to inherit a city's material system to share its GPU memory allocator.

## A workflow a coding agent can use

A purpose-built engine sounds expensive to create. For us, coding agents have changed how much of that work a small team can take on.

The scene is code. The compiler is code. The renderer is code. An agent can work across all three, run the build, deploy to a connected device, and read back measurements. It can inspect a failure in the same workflow in which it created the feature.

That gives us a practical loop:

1. Create the scene and interaction, with a browser reference to inspect.
2. Compile the content for a chosen machine.
3. Run the native build on that machine.
4. Capture the result and measure the frame time.
5. Use that evidence to revise the content, compiler, or renderer.

The device remains part of the loop. A successful build tells us that a program was produced. It takes a running game to tell us whether the memory use, controls, picture, and frame time are right.

During Atlas's release work, a build that ran through the PSP debugger stalled when started from the Memory Stick through the console's normal launcher. The problem was in how a worker thread found the content files. Testing that launch path exposed work that compiler tests and a debugger session had missed.

Performance needs the same specificity. Tokyo's recorded 150-second Vita tour produced 9,010 frames with no late frames in that run. Its PSP and 3DS versions use a 30 fps target and different rendering choices. Each result belongs to a particular game, build, device, and workload.

Those measurements tell the creator and the agent where to spend the next iteration.

## PocketJS still draws the interface

A game also needs a title screen, menus, a map, settings, and controls that work on the device in your hands.

Pocket3D projects use **PocketJS for that interface**. The game provides state and accepts commands; a PocketJS application presents it over the 3D scene.

A PSP needs focus and button navigation. A 3DS can put a map and touch interactions on its lower screen. An iPod needs controls designed for fingers. Those presentations can share their visual language and application flow while using the inputs and screens that each device provides.

This brings the work back to where PocketJS started. The 3D renderer can concentrate on the world, while a familiar component model handles the software around it.

## A place to play and share it

Alongside Pocket3D, we are opening **[Pocket Studio](https://studio.pocket.nexus/)**.

Studio gives these projects a place to live. You can explore the games, try their browser versions, visit their pages, and find the packages available for supported devices. The room puts a workbench, games, and handhelds together in a space you can interact with.

The browser is also a rendering target. Our flagship projects use their own WebAssembly and WebGPU implementations for these previews, with PocketJS interfaces and device-shaped controls. They let someone try a game before installing it. The image and performance in a browser can differ from the native build on a handheld.

For creation, Studio connects to coding agents such as Claude Code and Codex on your own computer. You work with the project's code, preview it, publish it, and return to it for another iteration. Remix provides a starting point when you want to learn from an existing project.

There is still work ahead to make creation easier. The launch workflow uses a local coding agent, and the more specialized Pocket3D projects retain their own build pipelines. We want to shorten the distance from an idea to something another person can play, while preserving the ability to go deep into the machine.

## Make something for a screen you love

Our mission at Pocket Nexus is to let everyone enjoy creating.

The devices on my desk already have good screens, buttons, speakers, and years of personal history attached to them. PocketJS gave us a way to write new interfaces for them. Pocket3D extends that work into worlds and games. Studio gives those creations somewhere to be played and shared.

You can start with [Pocket Tokyo](https://studio.pocket.nexus/games/tokyo), [Atlas](https://studio.pocket.nexus/games/atlas), [Maneuver](https://studio.pocket.nexus/games/maneuver), or [Requiem](https://studio.pocket.nexus/games/requiem) in your browser. The [Pocket3D site](https://3d.pocket.nexus/) walks through the rendering examples, and the [PocketJS repository](https://github.com/pocket-nexus/pocketjs/tree/main/pocket3d) contains the shared code and documentation.

If there is a game you have wanted to make for a machine you still keep around, we want you to be able to make it—and hand that machine to someone else to play.

Follow [@pocket_js](https://x.com/pocket_js) for what we build next.
