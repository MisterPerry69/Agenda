// ====== CONFIG ======
// URL del Web App di Apps Script (deve finire con /exec). Vedi README per il deploy.
var SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyfK9M2FA9oI-iCyUyCKg5aJZu6bK1V5lz5YcyQ3CoAXmksEGBXN3Wqm8kRMEMONvio/exec';

var CATS = ['lavoro','casa','libero','cazzeggio'];
var state = { view:'day', anchor:_todayISO(), entries:[], editing:null, selCat:'lavoro' };

// ====== API (fetch al backend GAS) ======
// GET per leggere, POST text/plain per scrivere (evita il preflight CORS).
function apiGet(params){
  var qs = Object.keys(params).map(function(k){ return encodeURIComponent(k)+'='+encodeURIComponent(params[k]); }).join('&');
  return fetch(SCRIPT_URL+'?'+qs)
    .then(function(r){ return r.json(); })
    .then(function(j){ if(!j.ok) throw new Error(j.error||'errore backend'); return j.data; });
}
function apiPost(body){
  return fetch(SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body: JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(j){ if(!j.ok) throw new Error(j.error||'errore backend'); return j.data; });
}

function _todayISO(){ var d=new Date(); var m=('0'+(d.getMonth()+1)).slice(-2), day=('0'+d.getDate()).slice(-2); return d.getFullYear()+'-'+m+'-'+day; }
function openAgenda(){ document.getElementById('cover').classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); load(); }

// ====== caricamento (solo Sheet via getAgenda) ======
function _rangeFor(view, anchor){
  var p = anchor.split('-'); var d = new Date(+p[0],+p[1]-1,+p[2]);
  function f(x){ var m=('0'+(x.getMonth()+1)).slice(-2),dd=('0'+x.getDate()).slice(-2); return x.getFullYear()+'-'+m+'-'+dd; }
  if(view==='day') return {from:anchor,to:anchor};
  if(view==='week'){ var dow=(d.getDay()+6)%7; var s=new Date(d); s.setDate(d.getDate()-dow); var e=new Date(s); e.setDate(s.getDate()+6); return {from:f(s),to:f(e)}; }
  var first=new Date(d.getFullYear(),d.getMonth(),1), last=new Date(d.getFullYear(),d.getMonth()+1,0);
  return {from:f(first),to:f(last)};
}

function load(){
  var r = _rangeFor(state.view, state.anchor);
  document.getElementById('ag-body').innerHTML = '<div class="ag-empty">Carico…</div>';
  apiGet({ action:'getAgenda', from:r.from, to:r.to })
    .then(function(rows){ state.entries = rows || []; render(); })
    .catch(function(err){ alert('Errore: '+err.message); });
}

function _titleFor(){
  var p = state.anchor.split('-'); var d = new Date(+p[0],+p[1]-1,+p[2]);
  var giorni=['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
  var mesi=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
  if(state.view==='day') return giorni[d.getDay()]+' '+d.getDate()+' '+mesi[d.getMonth()];
  if(state.view==='month') return mesi[d.getMonth()]+' '+d.getFullYear();
  return 'Settimana — '+mesi[d.getMonth()];
}

function _esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

function _lineHTML(e){
  var dot = e.onGoogle ? '<span class="ag-gdot"></span>' : '';
  return '<div class="ag-line" onclick="openEditor('+"'"+e.id+"'"+')">'
    +'<div class="ag-time">'+e.time+'</div>'
    +'<div class="ag-txt">'+_esc(e.title)+dot+'</div>'
    +'<div class="ag-tag tag-'+e.category+'">'+e.category+'</div></div>';
}

function renderDay(){
  var body = document.getElementById('ag-body');
  if(!state.entries.length){ body.innerHTML='<div class="ag-empty">Niente per oggi.<br>Tap ＋ per aggiungere.</div>'; return; }
  body.innerHTML = state.entries.map(_lineHTML).join('');
}

function _byDay(){
  var map={}; state.entries.forEach(function(e){ (map[e.date]=map[e.date]||[]).push(e); });
  return map;
}

function renderWeek(){
  var map=_byDay(); var keys=Object.keys(map).sort();
  var giorni=['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
  var body=document.getElementById('ag-body');
  if(!keys.length){ body.innerHTML='<div class="ag-empty">Settimana vuota.</div>'; return; }
  body.innerHTML = keys.map(function(k){
    var p=k.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
    var head='<div class="wk-day" onclick="goDay('+"'"+k+"'"+')">'+giorni[d.getDay()]+' '+d.getDate()+'</div>';
    var items=map[k].map(function(e){ return '<div class="wk-item">'+e.time+' '+_esc(e.title)+(e.onGoogle?'<span class="ag-gdot"></span>':'')+'</div>'; }).join('');
    return '<div class="wk-block">'+head+items+'</div>';
  }).join('');
}

function renderMonth(){
  var p=state.anchor.split('-'); var year=+p[0], month=+p[1]-1;
  var first=new Date(year,month,1); var startDow=(first.getDay()+6)%7; // lun=0
  var days=new Date(year,month+1,0).getDate();
  var map=_byDay();
  var cells=[];
  for(var i=0;i<startDow;i++) cells.push('<div class="mo-cell mo-empty"></div>');
  for(var dnum=1;dnum<=days;dnum++){
    var key=year+'-'+('0'+(month+1)).slice(-2)+'-'+('0'+dnum).slice(-2);
    var items=map[key]||[];
    var dots=items.slice(0,4).map(function(e){ return '<span class="mo-dot tag-'+e.category+'"></span>'; }).join('');
    cells.push('<div class="mo-cell" onclick="goDay('+"'"+key+"'"+')"><div class="mo-num">'+dnum+'</div><div class="mo-dots">'+dots+'</div></div>');
  }
  document.getElementById('ag-body').innerHTML =
    '<div class="mo-grid"><div class="mo-h">L</div><div class="mo-h">M</div><div class="mo-h">M</div><div class="mo-h">G</div><div class="mo-h">V</div><div class="mo-h">S</div><div class="mo-h">D</div>'
    + cells.join('') + '</div>';
}

function render(){
  document.getElementById('ag-title').textContent = _titleFor();
  if(state.view==='day') return renderDay();
  if(state.view==='week') return renderWeek();
  return renderMonth();
}

function goDay(k){ state.anchor=k; state.view='day';
  Array.prototype.forEach.call(document.querySelectorAll('.vbtn'),function(x){x.classList.toggle('active', x.getAttribute('data-view')==='day');});
  load();
}

// ====== navigazione date + switch viste ======
function _shiftAnchor(delta){
  var p=state.anchor.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
  if(state.view==='day') d.setDate(d.getDate()+delta);
  else if(state.view==='week') d.setDate(d.getDate()+7*delta);
  else d.setMonth(d.getMonth()+delta);
  var m=('0'+(d.getMonth()+1)).slice(-2),dd=('0'+d.getDate()).slice(-2);
  state.anchor=d.getFullYear()+'-'+m+'-'+dd; load();
}
document.getElementById('nav-prev').onclick=function(){ _shiftAnchor(-1); };
document.getElementById('nav-next').onclick=function(){ _shiftAnchor(1); };
Array.prototype.forEach.call(document.querySelectorAll('.vbtn'), function(b){
  b.onclick=function(){
    Array.prototype.forEach.call(document.querySelectorAll('.vbtn'),function(x){x.classList.remove('active');});
    b.classList.add('active'); state.view=b.getAttribute('data-view'); load();
  };
});

// ====== editor voce ======
function _renderCats(){
  document.getElementById('ed-cats').innerHTML = CATS.map(function(c){
    return '<span class="ed-cat tag-'+c+(c===state.selCat?' sel':'')+'" onclick="selCat('+"'"+c+"'"+')">'+c+'</span>';
  }).join('');
}
function selCat(c){ state.selCat=c; _renderCats(); }

function openEditor(id){
  state.editing = null; state.selCat = 'lavoro';
  document.getElementById('ed-title').value = '';
  document.getElementById('ed-time').value = '';
  document.getElementById('ed-google').checked = false;
  if(id){
    var e = state.entries.filter(function(x){return x.id===id;})[0];
    if(e){ state.editing=e; state.selCat=e.category||'lavoro';
      document.getElementById('ed-title').value=e.title;
      document.getElementById('ed-time').value=e.time;
      document.getElementById('ed-google').checked=!!e.onGoogle; }
  }
  _renderCats();
  document.getElementById('ed-delete').classList.toggle('hidden', !id);
  document.getElementById('editor').classList.remove('hidden');
}

function closeEditor(){ document.getElementById('editor').classList.add('hidden'); }

function saveEntry(){
  var title = document.getElementById('ed-title').value.trim();
  var time = document.getElementById('ed-time').value;
  if(!title){ alert('Scrivi cosa'); return; }
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)){ alert('Orario obbligatorio'); return; }
  var btn=document.getElementById('ed-save'); btn.disabled=true; btn.textContent='Salvo...';
  var entry = { date: state.anchor, time:time, title:title, category:state.selCat,
    onGoogle: document.getElementById('ed-google').checked };
  var done = function(){ btn.disabled=false; btn.textContent='Salva'; closeEditor(); load(); };
  var fail = function(err){ btn.disabled=false; btn.textContent='Salva'; alert('Errore: '+err.message); };
  if(state.editing){
    entry.id=state.editing.id; entry.eventId=state.editing.eventId; entry.linkedNoteId=state.editing.linkedNoteId||'';
    apiPost({ action:'updateEntry', entry:entry }).then(done).catch(fail);
  } else {
    apiPost({ action:'addEntry', entry:entry }).then(done).catch(fail);
  }
}

function deleteCurrent(){
  if(!state.editing) return;
  if(!confirm('Eliminare?')) return;
  apiPost({ action:'deleteEntry', id:state.editing.id })
    .then(function(){ closeEditor(); load(); })
    .catch(function(err){ alert('Errore: '+err.message); });
}

// ====== service worker (PWA) ======
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function(){
    navigator.serviceWorker.register('sw.js').catch(function(e){ console.warn('SW non registrato', e); });
  });
}
