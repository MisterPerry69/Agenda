// ====== CONFIG ======
// URL del Web App di Apps Script (deve finire con /exec). Vedi README per il deploy.
var SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyfK9M2FA9oI-iCyUyCKg5aJZu6bK1V5lz5YcyQ3CoAXmksEGBXN3Wqm8kRMEMONvio/exec';

var CATS = ['lavoro','casa','libero','cazzeggio'];
var POSTIT_COLORS = ['#ff93cf','#fff04d','#84d2ff','#a7ef5e','#ffb27a'];

var state = { view:'day', anchor:_todayISO(), editing:null, selCat:'lavoro' };

// ====== CACHE LOCALE (fruizione immediata) ======
// Tutte le voci stanno in cache; le viste leggono da qui (istantanee).
// La cache si popola dietro la cover e si riallinea col backend in background.
var cache = { entries: [], loadedAt: 0 };
function _loadCache(){
  try{ var c = JSON.parse(localStorage.getItem('ql_cache')||'null'); if(c&&c.entries) cache=c; }catch(e){}
}
function _saveCache(){ try{ localStorage.setItem('ql_cache', JSON.stringify(cache)); }catch(e){} }
function _entriesIn(from,to){
  return cache.entries.filter(function(e){ return e.date>=from && e.date<=to; })
    .sort(function(a,b){ return (a.date+a.time)<(b.date+b.time)?-1:1; });
}
function _upsert(entry){
  var i = cache.entries.findIndex(function(e){ return e.id===entry.id; });
  if(i>=0) cache.entries[i]=entry; else cache.entries.push(entry);
  _saveCache();
}
function _removeLocal(id){ cache.entries = cache.entries.filter(function(e){ return e.id!==id; }); _saveCache(); }

// ====== API (fetch al backend GAS) ======
function apiGet(params){
  var qs = Object.keys(params).map(function(k){ return encodeURIComponent(k)+'='+encodeURIComponent(params[k]); }).join('&');
  return fetch(SCRIPT_URL+'?'+qs).then(function(r){ return r.json(); })
    .then(function(j){ if(!j.ok) throw new Error(j.error||'errore backend'); return j.data; });
}
function apiPost(body){
  return fetch(SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain;charset=utf-8'}, body:JSON.stringify(body) })
    .then(function(r){ return r.json(); })
    .then(function(j){ if(!j.ok) throw new Error(j.error||'errore backend'); return j.data; });
}

function _todayISO(){ var d=new Date(); return _fmt(d); }
function _fmt(d){ var m=('0'+(d.getMonth()+1)).slice(-2),dd=('0'+d.getDate()).slice(-2); return d.getFullYear()+'-'+m+'-'+dd; }

// ====== AVVIO: precarica dietro la cover, poi tutto è istantaneo ======
function openAgenda(){
  document.getElementById('cover').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  render(); // subito dalla cache (anche vuota)
}
function boot(){
  _loadCache();
  _loadPostit();
  // precarica un ampio intervallo (anno corrente ± qualche mese) in background
  var y = new Date().getFullYear();
  syncRange((y-1)+'-12-01', (y+1)+'-01-31');
}
function syncRange(from,to){
  apiGet({ action:'getAgenda', from:from, to:to })
    .then(function(rows){
      // sostituisce le voci dell'intervallo con quelle fresche dal server
      cache.entries = cache.entries.filter(function(e){ return e.date<from || e.date>to; }).concat(rows||[]);
      cache.loadedAt = Date.now(); _saveCache();
      render();
    })
    .catch(function(e){ console.warn('sync fallita (uso cache):', e.message); });
}

// ====== RANGE / TITOLI ======
function _rangeFor(view, anchor){
  var p=anchor.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
  if(view==='day') return {from:anchor,to:anchor};
  if(view==='week'){ var dow=(d.getDay()+6)%7; var s=new Date(d); s.setDate(d.getDate()-dow); var e=new Date(s); e.setDate(s.getDate()+6); return {from:_fmt(s),to:_fmt(e)}; }
  return {from:_fmt(new Date(d.getFullYear(),d.getMonth(),1)), to:_fmt(new Date(d.getFullYear(),d.getMonth()+1,0))};
}
var GIORNI=['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
var MESI=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
function _titleFor(){
  var p=state.anchor.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
  if(state.view==='day') return '<span>'+d.getDate()+' '+MESI[d.getMonth()].toUpperCase()+'</span><span class="dow">'+GIORNI[d.getDay()]+'</span>';
  if(state.view==='month') return '<span>'+MESI[d.getMonth()].toUpperCase()+'</span><span class="dow">'+d.getFullYear()+'</span>';
  return '<span>SETTIMANA</span><span class="dow">'+MESI[d.getMonth()]+'</span>';
}
function _esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

// ====== RENDER ======
function render(){
  document.getElementById('ag-title').innerHTML = _titleFor();
  var r=_rangeFor(state.view,state.anchor);
  var rows=_entriesIn(r.from,r.to);
  if(state.view==='day') return renderDay(rows);
  if(state.view==='week') return renderWeek(rows);
  return renderMonth(rows);
}

function renderDay(rows){
  var body=document.getElementById('ag-body');
  body.ondblclick=function(ev){ if(!ev.target.closest('.ag-line')) openEditor(); };
  if(!rows.length){ body.innerHTML='<div class="ag-empty">Niente per oggi.<br>Doppio tap per aggiungere.</div>'; return; }
  body.innerHTML = rows.map(function(e){
    var pin=e.onGoogle?'<span class="ag-pin">📌</span>':'';
    return '<div class="ag-line'+(e.done?' done':'')+'" data-id="'+e.id+'">'
      +'<span class="ag-check'+(e.done?' done':'')+'" data-act="check"></span>'
      +'<span class="ag-time" data-act="edit">'+e.time+'</span>'
      +'<span class="ag-txt" data-act="edit">'+_esc(e.title)+pin+'</span>'
      +'<span class="ag-tag tag-'+e.category+'" data-act="edit"><span>'+e.category+'</span></span>'
      +'</div>';
  }).join('');
  Array.prototype.forEach.call(body.querySelectorAll('.ag-line'), function(line){
    var id=line.getAttribute('data-id');
    line.addEventListener('click', function(ev){
      var act=(ev.target.getAttribute('data-act'))||(ev.target.parentElement&&ev.target.parentElement.getAttribute('data-act'));
      if(act==='check') toggleDone(id); else if(act==='edit') openEditor(id);
    });
  });
}

function _byDay(rows){ var m={}; rows.forEach(function(e){ (m[e.date]=m[e.date]||[]).push(e); }); return m; }

function renderWeek(rows){
  var body=document.getElementById('ag-body'); body.ondblclick=function(ev){ if(!ev.target.closest('.wk-block')) openEditor(); };
  var map=_byDay(rows), keys=Object.keys(map).sort(); var G=['Dom','Lun','Mar','Mer','Gio','Ven','Sab'];
  if(!keys.length){ body.innerHTML='<div class="ag-empty">Settimana vuota.<br>Doppio tap per aggiungere.</div>'; return; }
  body.innerHTML = keys.map(function(k){
    var p=k.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
    var head='<div class="wk-day" onclick="goDay(\''+k+'\')">'+G[d.getDay()]+' '+d.getDate()+'</div>';
    var items=map[k].map(function(e){ return '<div class="wk-item">'+e.time+' '+_esc(e.title)+(e.onGoogle?' 📌':'')+'</div>'; }).join('');
    return '<div class="wk-block">'+head+items+'</div>';
  }).join('');
}

function renderMonth(rows){
  var body=document.getElementById('ag-body'); body.ondblclick=null;
  var p=state.anchor.split('-'); var year=+p[0], month=+p[1]-1;
  var startDow=(new Date(year,month,1).getDay()+6)%7, days=new Date(year,month+1,0).getDate();
  var map=_byDay(rows), today=_todayISO();
  var cells='';
  for(var i=0;i<startDow;i++) cells+='<div class="mo-cell mo-empty"></div>';
  for(var dn=1;dn<=days;dn++){
    var key=year+'-'+('0'+(month+1)).slice(-2)+'-'+('0'+dn).slice(-2);
    var items=map[key]||[];
    var evs=items.slice(0,3).map(function(e){ return '<div class="mo-ev tag-'+e.category+'"><span>'+_esc(e.title)+'</span></div>'; }).join('');
    cells+='<div class="mo-cell'+(key===today?' today':'')+'" onclick="goDay(\''+key+'\')"><div class="mo-num">'+dn+'</div>'+evs+'</div>';
  }
  body.innerHTML='<div class="mo-grid"><div class="mo-h">L</div><div class="mo-h">M</div><div class="mo-h">M</div><div class="mo-h">G</div><div class="mo-h">V</div><div class="mo-h">S</div><div class="mo-h">D</div>'+cells+'</div>';
}

function goDay(k){ state.anchor=k; _setView('day'); }

// ====== NAVIGAZIONE / VISTE ======
function _shiftAnchor(delta){
  var p=state.anchor.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
  if(state.view==='day') d.setDate(d.getDate()+delta);
  else if(state.view==='week') d.setDate(d.getDate()+7*delta);
  else d.setMonth(d.getMonth()+delta);
  state.anchor=_fmt(d); render();
}
function _setView(v){
  state.view=v;
  Array.prototype.forEach.call(document.querySelectorAll('.vbtn'),function(b){ b.classList.toggle('active', b.getAttribute('data-view')===v); });
  render();
}
document.getElementById('nav-prev').onclick=function(){ _shiftAnchor(-1); };
document.getElementById('nav-next').onclick=function(){ _shiftAnchor(1); };
Array.prototype.forEach.call(document.querySelectorAll('.vbtn'),function(b){ b.onclick=function(){ _setView(b.getAttribute('data-view')); }; });

// ====== DONE (ottimistico) ======
function toggleDone(id){
  var e=cache.entries.find(function(x){ return x.id===id; }); if(!e) return;
  e.done=!e.done; _saveCache(); render();                 // UI subito
  apiPost({ action:'updateEntry', entry:e }).catch(function(err){ console.warn('save done bg:', err.message); });
}

// ====== EDITOR ======
function _renderCats(){
  document.getElementById('ed-cats').innerHTML = CATS.map(function(c){
    return '<button class="ed-cat tag-'+c+(c===state.selCat?' sel':'')+'" onclick="selCat(\''+c+'\')"><span>'+c+'</span></button>';
  }).join('');
}
function selCat(c){ state.selCat=c; _renderCats(); }
function openEditor(id){
  state.editing=null; state.selCat='lavoro';
  document.getElementById('ed-title').value='';
  document.getElementById('ed-time').value='';
  document.getElementById('ed-google').checked=false;
  if(id){
    var e=cache.entries.find(function(x){ return x.id===id; });
    if(e){ state.editing=e; state.selCat=e.category||'lavoro';
      document.getElementById('ed-title').value=e.title;
      document.getElementById('ed-time').value=e.time;
      document.getElementById('ed-google').checked=!!e.onGoogle; }
  }
  _renderCats();
  document.getElementById('ed-delete').classList.toggle('hidden', !id);
  document.getElementById('editor').classList.remove('hidden');
  setTimeout(function(){ document.getElementById('ed-title').focus(); },80);
}
function closeEditor(){ document.getElementById('editor').classList.add('hidden'); }

function saveEntry(){
  var title=document.getElementById('ed-title').value.trim();
  var time=document.getElementById('ed-time').value;
  if(!title){ alert('Scrivi cosa'); return; }
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)){ alert('Orario obbligatorio'); return; }
  var entry={ date:state.anchor, time:time, title:title, category:state.selCat,
    onGoogle:document.getElementById('ed-google').checked,
    done:(state.editing&&state.editing.done)||false };
  if(state.editing){
    entry.id=state.editing.id; entry.eventId=state.editing.eventId; entry.linkedNoteId=state.editing.linkedNoteId||'';
    _upsert(entry); render(); closeEditor();                                  // UI subito
    apiPost({ action:'updateEntry', entry:entry }).then(function(saved){ _upsert(saved); }).catch(function(e){ console.warn('upd bg:',e.message); });
  } else {
    // id provvisorio locale; il server ne assegna uno definitivo
    entry.id='tmp_'+Date.now(); entry.eventId='';
    _upsert(entry); render(); closeEditor();                                  // UI subito
    var tmpId=entry.id; var toSend=Object.assign({},entry); delete toSend.id;
    apiPost({ action:'addEntry', entry:toSend })
      .then(function(saved){ _removeLocal(tmpId); _upsert(saved); render(); })
      .catch(function(e){ console.warn('add bg:',e.message); });
  }
}
function deleteCurrent(){
  if(!state.editing) return;
  if(!confirm('Eliminare?')) return;
  var id=state.editing.id;
  _removeLocal(id); render(); closeEditor();                                  // UI subito
  apiPost({ action:'deleteEntry', id:id }).catch(function(e){ console.warn('del bg:',e.message); });
}

// ====== POST-IT (nota globale) ======
var postit = { text:'', color:POSTIT_COLORS[0] };
function _loadPostit(){
  try{ var p=JSON.parse(localStorage.getItem('ql_postit')||'null'); if(p) postit=p; }catch(e){}
  document.documentElement.style.setProperty('--postit', postit.color);
}
function _savePostitLocal(){ try{ localStorage.setItem('ql_postit', JSON.stringify(postit)); }catch(e){} }
function openPostit(){
  document.getElementById('postit-text').value = postit.text;
  document.documentElement.style.setProperty('--postit', postit.color);
  document.getElementById('postit-colors').innerHTML = POSTIT_COLORS.map(function(c){
    return '<button style="background:'+c+'" onclick="setPostitColor(\''+c+'\')"></button>';
  }).join('');
  document.getElementById('postit-modal').classList.remove('hidden');
  // carica versione fresca dal server in bg
  apiGet({ action:'getNote' }).then(function(d){ if(d&&typeof d.text==='string'){ postit.text=d.text; if(d.color) postit.color=d.color; _savePostitLocal();
    if(!document.getElementById('postit-modal').classList.contains('hidden')) document.getElementById('postit-text').value=postit.text; } }).catch(function(){});
}
function setPostitColor(c){ postit.color=c; document.documentElement.style.setProperty('--postit',c); _savePostitLocal(); _pushNote(); }
function closePostit(){
  postit.text=document.getElementById('postit-text').value;
  _savePostitLocal(); _pushNote();
  document.getElementById('postit-modal').classList.add('hidden');
}
function _pushNote(){ apiPost({ action:'setNote', note:{ text:postit.text, color:postit.color } }).catch(function(e){ console.warn('note bg:',e.message); }); }

// ====== service worker (PWA) ======
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(e){ console.warn('SW:', e); }); });
}

boot();
