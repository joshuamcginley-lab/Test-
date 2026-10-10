"use strict";
/* Feel: launch splash, haptics, the "trip logged" moment with confetti for a new personal best,
   app-bar shadow on scroll, and pull-to-refresh on the Guide tab. Uses globals from the other scripts. */

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
function haptic(ms = 8) { try { navigator.vibrate?.(ms); } catch (e) {} }

/* ---------- launch splash (first open per session) ---------- */
(function splash() {
  const el = $("splash"); let seen = false;
  try { seen = sessionStorage.getItem("ft-splash") === "1"; sessionStorage.setItem("ft-splash", "1"); } catch (e) {}
  if (seen || reduceMotion) { el.remove(); return; }
  setTimeout(() => el.classList.add("out"), 650);
  setTimeout(() => el.remove(), 1100);
})();

/* ---------- app bar picks up a shadow once you scroll ---------- */
const bar = $("appbar");
addEventListener("scroll", () => bar.classList.toggle("scrolled", scrollY > 4), { passive: true });

/* ---------- press feedback for buttons that don't have it natively ---------- */
document.addEventListener("click", e => { if (e.target.closest(".btn-log, .dock-log, .choice, .seg button, .chip-btn")) haptic(6); }, true);

/* ---------- the "trip logged" moment ---------- */
let celTimer = null;
function celebrate({ fish = 0, pb = null, species = "", next = null } = {}) {
  const box = $("celebrate");
  $("celTitle").textContent = pb ? "New personal best" : fish ? `${fish} fish logged` : "Skunk logged";
  $("celSub").textContent = pb ? `${species ? species + " · " : ""}${fmtW(pb)}` : next ? next + (fish ? "" : " Skunks count too.") : (fish ? "Model retrained on your new data." : "Still training data. Your guide learns from skunks too.");
  box.classList.toggle("pb", !!pb);
  box.hidden = false; box.classList.remove("show"); void box.offsetWidth; box.classList.add("show");
  haptic(pb ? [12, 60, 20] : 14);
  if (pb && !reduceMotion) confetti();
  clearTimeout(celTimer);
  celTimer = setTimeout(() => { box.classList.remove("show"); setTimeout(() => { box.hidden = true; }, 300); }, pb ? 2600 : next ? 2600 : 1500);
}
$("celebrate").addEventListener("click", () => { clearTimeout(celTimer); $("celebrate").classList.remove("show"); setTimeout(() => { $("celebrate").hidden = true; }, 300); });

function confetti() {
  const cv = $("confetti"), ctx = cv.getContext("2d"), dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const colors = ["#C4FF2E", "#7DEB3A", "#FFB21A", "#FF6A13", "#EEF2E8"];
  const parts = Array.from({ length: 140 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 80, y: innerHeight * .42,
    vx: (Math.random() - .5) * 13, vy: -Math.random() * 15 - 4, r: Math.random() * 6 + 3,
    a: Math.random() * Math.PI, va: (Math.random() - .5) * .3, c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const t0 = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += .42; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.a += p.va;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (t - t0 < 2600) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(t0);
}

/* ---------- pull to refresh on the Guide tab ---------- */
(function pullToRefresh() {
  const ind = document.createElement("div"); ind.className = "ptr"; ind.innerHTML = `<span class="ptr-spin"></span>`; document.body.append(ind);
  let y0 = null, dy = 0;
  addEventListener("touchstart", e => {
    y0 = !$("panel-advice").hidden && scrollY <= 0 && !document.querySelector(".sheet:not([hidden])") && !e.target.closest(".leaflet-container") ? e.touches[0].clientY : null; dy = 0;
  }, { passive: true });
  addEventListener("touchmove", e => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    const k = Math.min(1, dy / 90);
    ind.style.transform = `translate(-50%, ${Math.min(70, dy * .6)}px) rotate(${dy * 3}deg)`; ind.style.opacity = k;
    ind.classList.toggle("ready", dy > 90);
  }, { passive: true });
  addEventListener("touchend", () => {
    if (y0 == null) return;
    const go = dy > 90; y0 = null;
    if (go && typeof goLive === "function") {
      ind.classList.add("spinning"); haptic(10);
      goLive(true).finally(() => { ind.classList.remove("spinning", "ready"); ind.style.transform = ""; ind.style.opacity = 0; });
    } else { ind.style.transform = ""; ind.style.opacity = 0; ind.classList.remove("ready"); }
  });
})();

/* ---------- long tables show their top rows (clampTables in app.js) after every render ---------- */
{ const _renderForClamp = render; render = function () { _renderForClamp(); clampTables(); }; clampTables(); }

/* ---------- sheets: Back closes them, and keyboard focus stays inside ---------- */
// Every sheet opens with the scrim, so watching the scrim covers them all. An open sheet adds one history entry;
// the phone's Back button (or swipe back) then closes the sheet instead of leaving fishr and losing what was typed.
// Closing a sheet any other way takes that entry back off.
(function sheetHistory() {
  const scrim = $("scrim"); let ownBack = false, lastFocus = null;
  const openSheet = () => [...document.querySelectorAll(".sheet")].find(s => !s.hidden);
  const focusables = el => [...el.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]
    .filter(x => x.offsetParent !== null || x.tagName === "SELECT");
  new MutationObserver(() => {
    const open = !scrim.hidden;
    if (open && !history.state?.fishrSheet) {
      history.pushState({ ...(history.state || {}), fishrSheet: true }, "");
      lastFocus = document.activeElement;
      // Move focus into the sheet unless something in it already has it.
      setTimeout(() => {
        const s = openSheet(); if (!s || s.contains(document.activeElement)) return;
        const h = s.querySelector("h2") || s; h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true });
      }, 0);
    } else if (!open && history.state?.fishrSheet) {
      ownBack = true; history.back();
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true }); lastFocus = null;
    }
  }).observe(scrim, { attributes: true, attributeFilter: ["hidden"] });
  addEventListener("popstate", () => {
    if (ownBack) { ownBack = false; return; }
    if (!scrim.hidden) closeSheets();
  });
  // Tab and Shift+Tab cycle inside the open sheet.
  document.addEventListener("keydown", e => {
    if (e.key !== "Tab" || scrim.hidden) return;
    const s = openSheet(); if (!s) return;
    const f = focusables(s); if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (!s.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
})();
