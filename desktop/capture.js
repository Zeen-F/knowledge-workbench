const image = document.querySelector("#screen"),
  box = document.querySelector("#selection"),
  size = document.querySelector("#size");
window.capture.image().then((data) => {
  image.src = data;
});
let start,
  selected,
  busy = false;
document.addEventListener("pointerdown", (e) => {
  if (busy || e.button !== 0) return;
  start = { x: e.clientX, y: e.clientY };
  document.body.setPointerCapture(e.pointerId);
  document.querySelector("#shade").style.display = "none";
});
document.addEventListener("pointermove", (e) => {
  if (!start || busy) return;
  const x = Math.max(0, Math.min(innerWidth, e.clientX)),
    y = Math.max(0, Math.min(innerHeight, e.clientY));
  selected = {
    x: Math.min(x, start.x),
    y: Math.min(y, start.y),
    width: Math.abs(x - start.x),
    height: Math.abs(y - start.y),
  };
  Object.assign(box.style, {
    display: "block",
    left: selected.x + "px",
    top: selected.y + "px",
    width: selected.width + "px",
    height: selected.height + "px",
  });
  size.textContent = `${Math.round(selected.width)} × ${Math.round(selected.height)}`;
});
document.addEventListener("pointerup", async () => {
  if (!start || busy) return;
  start = null;
  if (!selected || selected.width < 2 || selected.height < 2) return;
  busy = true;
  try {
    await window.capture.select(selected);
  } catch {
    window.capture.cancel();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.capture.cancel();
});
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.capture.cancel();
});
