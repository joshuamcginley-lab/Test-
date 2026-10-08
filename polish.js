"use strict";
/* Feel: launch splash, haptics, the "trip logged" moment with confetti for a new personal best,
   app-bar shadow on scroll, and pull-to-refresh on Copilot. Uses globals from the other scripts. */

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
function celebrate({ fish = 0, pb = null, species = "" } = {}) {
  const box = $("celebrate");
  $("celTitle").textContent = pb ? "New personal best" : fish ? `${fish} fish logged` : "Skunk logged";
  $("celSub").textContent = pb ? `${species ? species + " · " : ""}${fmtW(pb)}` : fish ? "Model retrained on your new data." : "Still training data. Copilot learns from skunks too.";
  box.classList.toggle("pb", !!pb);
  box.hidden = false; box.classList.remove("show"); void box.offsetWidth; box.classList.add("show");
  haptic(pb ? [12, 60, 20] : 14);
  if (pb && !reduceMotion) confetti();
  clearTimeout(celTimer);
  celTimer = setTimeout(() => { box.classList.remove("show"); setTimeout(() => { box.hidden = true; }, 300); }, pb ? 2600 : 1500);
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

/* ---------- pull to refresh on Copilot ---------- */
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

/* ---------- first visit: open the showcase sample so people see what fishr does ---------- */
// Anyone without trips of their own lands in the sample season (Copilot, Bite Index, full Insights).
// Once they log a trip, the app opens on their own log instead. Shared-catch links keep their own page.
if (!state.sessions.length && !demo && !/^#catch=/.test(location.hash)) loadSample().finally(() => document.body.classList.remove("booting"));
else document.body.classList.remove("booting");
setTimeout(() => document.body.classList.remove("booting"), 4000); // never leave the welcome screen hidden
