// Loaded before first paint so there is no light/dark flash. A file rather than an
// inline script, so the Content-Security-Policy can stay 'self' only.
try {
  const t = localStorage.getItem("theme");
  if (t) document.documentElement.dataset.theme = t;
} catch (e) {}
