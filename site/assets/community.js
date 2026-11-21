// Native horizontal scrolling keeps touch, wheel and keyboard navigation usable.
const wall = document.querySelector("[data-community-wall]");
const toggle = document.querySelector("[data-community-toggle]");

if (wall && toggle) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const hover = matchMedia("(hover: hover)");
  let visible = false;
  let paused = false;
  let touching = false;
  let holdUntil = 0;
  let previousTime = 0;

  const rows = [...wall.querySelectorAll(".community-row")].map((element, index) => {
    const original = element.querySelector(".community-set");
    const copy = original.cloneNode(true);
    copy.classList.add("community-copy");
    copy.setAttribute("aria-hidden", "true");
    // Copies stay clickable, but appear only once in keyboard/assistive navigation.
    for (const target of copy.querySelectorAll("a, summary")) target.tabIndex = -1;
    original.after(copy);
    const originals = [...original.querySelectorAll("details")];
    const copies = [...copy.querySelectorAll("details")];
    originals.forEach((detail, i) => {
      for (const [from, to] of [[detail, copies[i]], [copies[i], detail]]) {
        from.addEventListener("toggle", () => {
          if (to.open !== from.open) to.open = from.open;
        });
      }
    });
    const row = { element, original, distance: 0, position: 0, written: 0, direction: index === 1 ? -1 : 1 };
    new ResizeObserver(() => {
      row.distance = original.getBoundingClientRect().width;
      row.position = element.scrollLeft % row.distance;
      element.scrollLeft = row.position;
      row.written = element.scrollLeft;
    }).observe(original);
    return row;
  });

  const syncPreference = () => { toggle.hidden = reducedMotion.matches; };
  syncPreference();
  reducedMotion.addEventListener("change", syncPreference);
  toggle.addEventListener("click", () => {
    paused = !paused;
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? "Resume scrolling" : "Pause scrolling";
  });
  wall.addEventListener("pointerdown", () => { touching = true; }, { passive: true });
  const release = () => {
    if (!touching) return;
    touching = false;
    holdUntil = performance.now() + 3000;
  };
  window.addEventListener("pointerup", release, { passive: true });
  window.addEventListener("pointercancel", release, { passive: true });
  wall.addEventListener("wheel", () => { holdUntil = performance.now() + 3000; }, { passive: true });
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(wall);

  const advance = (time) => {
    const elapsed = previousTime ? Math.min(time - previousTime, 50) / 1000 : 0;
    previousTime = time;
    const reading = wall.matches(":focus-within") || wall.querySelector("details[open]")
      || (hover.matches && wall.matches(":hover"));
    if (visible && !document.hidden && !reducedMotion.matches && !paused && !touching && time >= holdUntil && !reading) {
      for (const row of rows) {
        if (!row.distance) continue;
        // Follow native scrolling before continuing; keep subpixel progress between frames.
        if (Math.abs(row.element.scrollLeft - row.written) > 1) row.position = row.element.scrollLeft;
        row.position = (row.position + row.direction * 24 * elapsed + row.distance) % row.distance;
        row.element.scrollLeft = row.position;
        row.written = row.element.scrollLeft;
      }
    }
    requestAnimationFrame(advance);
  };
  requestAnimationFrame(advance);
}
