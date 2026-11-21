const filters = [...document.querySelectorAll("[data-filter]")];
const cards = [...document.querySelectorAll("[data-app-card]")];
const validDevices = new Set(filters.map((button) => button.dataset.filter));

function filterApps(device, updateUrl = true) {
  if (!validDevices.has(device)) device = "all";
  for (const button of filters) button.setAttribute("aria-pressed", String(button.dataset.filter === device));
  let count = 0;
  for (const card of cards) {
    card.hidden = device !== "all" && !card.dataset.devices.split(" ").includes(device);
    if (!card.hidden) count++;
  }
  const status = document.querySelector(".sc-count");
  if (status) status.textContent = `${count} ${count === 1 ? "case" : "cases"}`;
  if (updateUrl) {
    const url = new URL(location.href);
    if (device === "all") url.searchParams.delete("device");
    else url.searchParams.set("device", device);
    history.replaceState(null, "", url);
  }
}

for (const button of filters) button.addEventListener("click", () => filterApps(button.dataset.filter));
filterApps(new URL(location.href).searchParams.get("device") || "all", false);
window.addEventListener("popstate", () => filterApps(new URL(location.href).searchParams.get("device") || "all", false));

// Links keep a real setup destination when scripting or <dialog> is unavailable.
for (const link of document.querySelectorAll("[data-open-app]")) {
  link.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const dialog = document.getElementById(`try-${link.dataset.openApp}`);
    if (!dialog?.showModal) return;
    event.preventDefault();
    dialog.showModal();
    dialog.scrollTop = 0;
  });
}
for (const dialog of document.querySelectorAll(".sc-dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
