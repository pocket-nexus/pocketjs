// The homepage's interactions: the framework tabs, the PocketUI theme
// buttons, and the community wall (community.js).
import "./community.js";

const select = (buttons, key, value) => {
  for (const button of buttons) {
    const on = button.dataset[key] === value;
    button.classList.toggle("on", on);
    button.setAttribute(button.getAttribute("role") === "tab" ? "aria-selected" : "aria-pressed", String(on));
  }
};

// Framework tabs: show one code sample and dim the other frameworks' bars.
const frameworkTabs = [...document.querySelectorAll("[data-fw]")];
const showFramework = (fw) => {
  select(frameworkTabs, "fw", fw);
  for (const pre of document.querySelectorAll("[data-fw-code]")) pre.classList.toggle("on", pre.dataset.fwCode === fw);
  for (const bar of document.querySelectorAll("[data-fw-bar]")) bar.classList.toggle("dim", bar.dataset.fwBar !== fw);
};
for (const tab of frameworkTabs) tab.addEventListener("click", () => showFramework(tab.dataset.fw));
if (frameworkTabs.length) showFramework("solid");

// PocketUI themes: the same gallery screen, captured in each theme.
const themeButtons = [...document.querySelectorAll(".themes [data-theme]")];
for (const button of themeButtons) {
  button.addEventListener("click", () => {
    select(themeButtons, "theme", button.dataset.theme);
    for (const img of document.querySelectorAll("[data-theme-stage] img")) {
      img.classList.toggle("on", img.dataset.theme === button.dataset.theme);
    }
  });
}

// Looping clips play only while they are on screen.
const clips = document.querySelectorAll("video[autoplay]");
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) void entry.target.play().catch(() => {});
      else entry.target.pause();
    }
  });
  for (const clip of clips) io.observe(clip);
}
