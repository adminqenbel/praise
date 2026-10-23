// Applies the saved light/dark choice before the page paints, so a reload doesn't flash the other look.
// Without a saved choice the personal space follows the device's setting (css).
(function () {
  try {
    var mode = localStorage.getItem("praise.mode");
    if (mode === "light" || mode === "dark") document.documentElement.dataset.mode = mode;
  } catch (e) { /* private window: follow the device */ }
})();
