(function () {
var D = document;
var TABS = [
{ id: 'dashboard', icon: '\u{1F4CA}', label: 'Painel' },
{ id: 'decisions', icon: '⚡', label: 'Decisoes' },
{ id: 'campaigns', icon: '\u{1F4E2}', label: 'Campanhas' },
{ id: 'insights', icon: '\u{1F9E0}', label: 'IA' }
];
function titleOf(id) { var t = TABS.filter(function (x) { return x.id === id; })[0]; if (t) { return t.label; } var el = D.getElementById('nav-' + id); if (el) { return (el.textContent || '').trim().split('\n')[0].trim(); } return 'IPPMIFY'; }
function closeDrawer() { var s = D.querySelector('.sidebar'); var o = D.getElementById('sidebarOverlay'); if (s) { s.classList.remove('open'); } if (o) { o.classList.remove('open'); } }
window.toggleMobileSidebar = function () { var s = D.querySelector('.sidebar'); var o = D.getElementById('sidebarOverlay'); if (s) { s.classList.toggle('open'); } if (o) { o.classList.toggle('open'); } };
window.closeMobileSidebar = function () { closeDrawer(); };
function sync(active) {
var t = D.querySelector('#ippTopBar .itb-title'); if (t) { t.textContent = titleOf(active); }
var items = D.querySelectorAll('#ippBottomNav .ibn-item');
for (var i = 0; i < items.length; i++) { if (items[i].getAttribute('data-tab') === active) { items[i].classList.add('active'); } else { items[i].classList.remove('active'); } }
}
function current() { var el = D.querySelector('.nav-item.active'); if (el && el.id) { return el.id.replace('nav-', ''); } return 'dashboard'; }
  function gate() { var auth = D.getElementById('authPage'); var logged = !(auth && getComputedStyle(auth).display !== 'none'); var nav = D.getElementById('ippBottomNav'); var top = D.getElementById('ippTopBar'); var btn = D.getElementById('mobileMenuBtn'); var v = logged ? '' : 'none'; if (nav) { nav.style.display = v; } if (top) { top.style.display = v; } if (btn) { btn.style.display = v; } var main = D.querySelector('.main'); if (main) { main.style.visibility = ''; } D.body.classList.toggle('ipp-logged', logged); }
function build() {
if (D.getElementById('ippBottomNav')) { return true; }
if (!D.querySelector('.sidebar')) { return false; }
var bar = D.createElement('div'); bar.id = 'ippTopBar';
var tt = D.createElement('div'); tt.className = 'itb-title'; tt.textContent = 'Painel';
bar.appendChild(tt); D.body.appendChild(bar);
var nav = D.createElement('div'); nav.id = 'ippBottomNav';
TABS.forEach(function (t) {
var b = D.createElement('button'); b.className = 'ibn-item'; b.setAttribute('data-tab', t.id);
var i = D.createElement('span'); i.className = 'ibn-icon'; i.textContent = t.icon;
var l = D.createElement('span'); l.className = 'ibn-lbl'; l.textContent = t.label;
b.appendChild(i); b.appendChild(l);
b.addEventListener('click', function () { if (typeof window.showTab === 'function') { window.showTab(t.id); } closeDrawer(); sync(t.id); window.scrollTo({ top: 0, behavior: 'smooth' }); });
nav.appendChild(b);
});
var m = D.createElement('button'); m.className = 'ibn-item'; m.setAttribute('data-tab', '__menu');
var mi = D.createElement('span'); mi.className = 'ibn-icon'; mi.textContent = '☰';
var ml = D.createElement('span'); ml.className = 'ibn-lbl'; ml.textContent = 'Menu';
m.appendChild(mi); m.appendChild(ml);
m.addEventListener('click', function () { window.toggleMobileSidebar(); });
nav.appendChild(m); D.body.appendChild(nav);
return true;
}
function wrapShowTab() {
if (typeof window.showTab !== 'function' || window.showTab.__ippWrapped) { return; }
var orig = window.showTab;
var wrapped = function (name) { var r = orig.apply(this, arguments); try { closeDrawer(); sync(name); } catch (e) {} return r; };
wrapped.__ippWrapped = true; window.showTab = wrapped;
}
function hints() {
if (!window.matchMedia('(max-width: 768px)').matches) { return; }
var sel = '#campDetailPanel div[style*="overflow-x:auto"], #adsSubPanel div[style*="overflow-x:auto"], .top-camp-table-wrap, .table-wrap';
var wraps = D.querySelectorAll(sel);
for (var i = 0; i < wraps.length; i++) {
var w = wraps[i];
if (w.getAttribute('data-hint') === '1') { continue; }
if (w.scrollWidth <= w.clientWidth + 4) { continue; }
w.setAttribute('data-hint', '1');
var h = D.createElement('div'); h.className = 'ipp-scrollhint'; h.textContent = '↔ Arraste para ver mais colunas';
if (w.parentNode) { w.parentNode.insertBefore(h, w); }
}
}
var n = 0;
var iv = setInterval(function () {
n++;
if (build()) { wrapShowTab(); sync(current()); }
hints(); gate();
if (n > 90) { clearInterval(iv); }
}, 1000);
D.addEventListener('DOMContentLoaded', function () { if (build()) { wrapShowTab(); sync(current()); } });
  D.addEventListener('click', function () { setTimeout(gate, 350); }, true);
window.addEventListener('resize', function () { sync(current()); });
})();
