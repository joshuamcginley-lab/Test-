"use strict";
/* "How fishr works": a short guide on the Guide screen. It opens with the loop (log catches, build a data set,
   catch more fish), then spotlights the parts of Guide that come from that data. Shows once, the first time someone
   opens the Guide tab from the showcase; "How fishr works" on the Guide tab replays it. Uses globals from app.js. */

const GUIDE_KEY = "fishr.guide";
const guideSteps = () => [
  { title: "How fishr works", intro: true, body: `
    <ol class="g-loop">
      <li><span class="g-num">1</span><span><b>Log catches</b>Every trip, fish or skunk: where, when and what you threw. Under a minute.</span></li>
      <li><span class="g-num">2</span><span><b>Build a data set</b>fishr adds the weather, pressure and river level to every trip. Your log becomes data nobody else has.</span></li>
      <li><span class="g-num">3</span><span><b>Catch more fish</b>Your guide matches today's conditions to your best days and tells you where to go.</span></li>
    </ol>
    <p>${demo ? "This showcase is one angler's data set: 47 trips. Here's what it does." : "Here's where your data shows up."}</p>` },
  { target: "live", title: "Today's conditions", body: "Live weather, pressure and river level where you are, once you allow location. This is what your guide compares against your data set." },
  { target: "advice", title: "The call comes from your data", body: `Your guide finds the trips in ${demo ? "this log" : "your log"} with conditions most like these, and shows what worked: the water, the time of day, the lure. <b>The more you log, the sharper the call.</b>` },
  { target: "ask", title: "Or just ask", body: `Ask fishr is the old-timer on the dock who has read the whole log. Ask him where to go Saturday, or what to throw after a cold front.${demo ? " Try one of the suggested questions on this season." : ""} <b>Free during the beta.</b>` },
  { target: "inputsBox", open: true, title: "Plan a trip", body: `Change the date, time, temperature or sky to plan a trip. The call updates from the same data.${demo ? ` The showcase starts on a July evening at ${fmtT(22)}.` : ""}` },
];

let gStep = 0, gSteps = [], gOpened = null;
const guideEl = document.createElement("div");
guideEl.className = "guide"; guideEl.id = "guide"; guideEl.hidden = true;
guideEl.innerHTML = `<div class="g-ring" id="gRing"></div>
  <div class="g-card" role="dialog" aria-modal="true" aria-labelledby="gTitle">
    <div class="g-top"><span class="g-step" id="gStepLbl"></span><button type="button" class="linkbtn" id="gSkip">Skip</button></div>
    <h3 id="gTitle"></h3><div class="g-body" id="gBody"></div>
    <div class="g-actions"><button type="button" class="btn" id="gBack">Back</button><button type="button" class="btn" id="gClose" hidden>Close</button><button type="button" class="btn primary" id="gNext">Next</button></div>
  </div>`;
document.body.append(guideEl);
guideEl.addEventListener("click", e => { if (e.target === guideEl) closeGuide(); }); // a tap outside the card closes it

function placeRing() {
  const s = gSteps[gStep], ring = $("gRing");
  if (guideEl.hidden || !s || !s.target) { ring.hidden = true; return; }
  const r = $(s.target).getBoundingClientRect(), card = guideEl.querySelector(".g-card").getBoundingClientRect();
  const top = Math.max(r.top - 6, 8), bottom = Math.min(r.bottom + 6, card.top - 10);
  Object.assign(ring.style, { top: top + "px", left: Math.max(r.left - 6, 6) + "px", width: Math.min(r.width + 12, innerWidth - 12) + "px", height: Math.max(48, bottom - top) + "px" });
  ring.hidden = false;
}
function showStep(i) {
  gStep = i; const s = gSteps[i], last = i === gSteps.length - 1;
  guideEl.classList.toggle("intro", !!s.intro);
  $("gStepLbl").textContent = `${i + 1} of ${gSteps.length}`;
  $("gTitle").textContent = s.title; $("gBody").innerHTML = s.body;
  $("gBack").hidden = i === 0 || last;
  $("gClose").hidden = !last; $("gSkip").hidden = last;
  $("gNext").textContent = last ? (demo ? "Start my data set" : "Log a trip") : "Next";
  if (s.open && $(s.target).tagName === "DETAILS" && !$(s.target).open) { $(s.target).open = true; gOpened = s.target; }
  $("gRing").hidden = true;
  if (s.target) {
    const bar = $("appbar").getBoundingClientRect().height;
    scrollTo({ top: $(s.target).getBoundingClientRect().top + scrollY - bar - 14, behavior: reduceMotion ? "auto" : "smooth" });
    setTimeout(placeRing, reduceMotion ? 0 : 380);
  }
  $("gNext").focus({ preventScroll: true });
}
function openGuide() {
  showTab("advice"); closeSheets(); gSteps = guideSteps().filter(s => !s.target || !$(s.target).hidden); gOpened = null;
  guideEl.hidden = false; document.body.classList.add("guiding");
  showStep(0);
}
function closeGuide(thenLog) {
  guideEl.hidden = true; document.body.classList.remove("guiding");
  if (gOpened) { $(gOpened).open = false; gOpened = null; }
  try { localStorage.setItem(GUIDE_KEY, "1"); } catch (e) {}
  markGuideSeen();
  scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  if (thenLog) startNewTrip();
}
// First time someone opens the Guide tab from the showcase.
function maybeGuide() {
  let seen = false; try { seen = localStorage.getItem(GUIDE_KEY) === "1"; } catch (e) {}
  if (!seen) setTimeout(openGuide, 350);
}

$("gNext").onclick = () => gStep < gSteps.length - 1 ? showStep(gStep + 1) : closeGuide(true);
$("gBack").onclick = () => showStep(Math.max(0, gStep - 1));
$("gSkip").onclick = $("gClose").onclick = () => closeGuide(false);
$("guideOpen").onclick = openGuide;
document.addEventListener("keydown", e => { if (!guideEl.hidden && e.key === "Escape") { e.stopImmediatePropagation(); closeGuide(false); } }, true);
addEventListener("resize", placeRing);
addEventListener("scroll", () => { if (!guideEl.hidden) placeRing(); }, { passive: true });

// "Start here" on the showcase's Guide tile. During the beta it stays for everyone; after the beta,
// set IN_BETA to false and it goes away once someone has been through the guide.
const IN_BETA = true;
function markGuideSeen() { if (!IN_BETA) document.querySelector(".sc-tile.start-here")?.classList.remove("start-here"); }
try { if (localStorage.getItem(GUIDE_KEY) === "1") markGuideSeen(); } catch (e) {}
