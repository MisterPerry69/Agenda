// ====== CONFIG ======
// URL del Web App di Apps Script (deve finire con /exec). Vedi README per il deploy.
var SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyfK9M2FA9oI-iCyUyCKg5aJZu6bK1V5lz5YcyQ3CoAXmksEGBXN3Wqm8kRMEMONvio/exec';

var CATS = ['lavoro','casa','libero','cazzeggio'];
var POSTIT_COLORS = ['#ff93cf','#fff04d','#84d2ff','#a7ef5e','#ffb27a'];

var state = { view:'day', anchor:_todayISO(), editing:null, selCat:'lavoro' };

// ====== CACHE LOCALE (fruizione immediata) ======
// Tutte le voci stanno in cache; le viste leggono da qui (istantanee).
// La cache si popola dietro la cover e si riallinea col backend in background.
// `pending`: id di voci con una scrittura non ancora confermata dal server.
// Il sync NON deve mai cancellarle (altrimenti "inserisco e ricaricando sparisce").
var cache = { entries: [], pending: [], loadedAt: 0 };
function _loadCache(){
  try{ var c = JSON.parse(localStorage.getItem('ql_cache')||'null'); if(c&&c.entries){ cache=c; if(!cache.pending) cache.pending=[]; } }catch(e){}
}
function _saveCache(){ try{ localStorage.setItem('ql_cache', JSON.stringify(cache)); }catch(e){} }
function _markPending(id){ if(cache.pending.indexOf(id)<0) cache.pending.push(id); }
function _clearPending(id){ cache.pending = cache.pending.filter(function(x){ return x!==id; }); }
function _entriesIn(from,to){
  return cache.entries.filter(function(e){ return !e._deleted && e.date>=from && e.date<=to; })
    .sort(function(a,b){ return (a.date+a.time)<(b.date+b.time)?-1:1; });
}
function _upsert(entry){
  var i = cache.entries.findIndex(function(e){ return e.id===entry.id; });
  if(i>=0) cache.entries[i]=entry; else cache.entries.push(entry);
  _saveCache();
}
function _removeLocal(id){ cache.entries = cache.entries.filter(function(e){ return e.id!==id; }); _clearPending(id); _saveCache(); }

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
  // badge bookmark: subito dalla cache, poi aggiorna col tracking fresco di oggi
  refreshBookmarkBadge();
  apiGet({ action:'getTracking', date:_todayISO() }).then(function(d){
    var fresh={}; (d&&d.entries||[]).forEach(function(e){ fresh[e.slot]=e; });
    _trkCacheSet(_todayISO(), fresh); refreshBookmarkBadge();
  }).catch(function(){});
}
function syncRange(from,to){
  var before = JSON.stringify(cache.entries);
  apiGet({ action:'getAgenda', from:from, to:to })
    .then(function(rows){
      // rimpiazza le voci dell'intervallo con quelle del server,
      // MA conserva quelle ancora "pending" (scrittura non confermata).
      var keep = cache.entries.filter(function(e){
        if(cache.pending.indexOf(e.id)>=0) return true;        // pending: non toccare
        return e.date<from || e.date>to;                        // fuori intervallo: resta
      });
      cache.entries = keep.concat(rows||[]);
      cache.loadedAt = Date.now(); _saveCache();
      // ridisegna SOLO se i dati sono davvero cambiati → niente flicker/refresh inutile
      if(JSON.stringify(cache.entries)!==before) render();
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
  // settimana: "SETT. 15 - 21 giu" (range reale)
  var r=_rangeFor('week',state.anchor); var s=r.from.split('-'), e=r.to.split('-');
  var sd=new Date(+s[0],+s[1]-1,+s[2]), ed=new Date(+e[0],+e[1]-1,+e[2]);
  var mlab = sd.getMonth()===ed.getMonth() ? MESI[ed.getMonth()] : MESI[sd.getMonth()].slice(0,3)+'/'+MESI[ed.getMonth()].slice(0,3);
  return '<span>SETT. '+sd.getDate()+'–'+ed.getDate()+'</span><span class="dow">'+mlab+'</span>';
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
  var body=document.getElementById('ag-body'); body.ondblclick=null;
  var map=_byDay(rows); var G=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
  var today=_todayISO();
  // tutti e 7 i giorni della settimana, preimpostati (anche vuoti), uno sotto l'altro
  var r=_rangeFor('week',state.anchor); var s=r.from.split('-');
  var start=new Date(+s[0],+s[1]-1,+s[2]);
  var html='';
  for(var i=0;i<7;i++){
    var d=new Date(start); d.setDate(start.getDate()+i); var k=_fmt(d);
    var items=(map[k]||[]).map(function(e){
      return '<div class="wk-item tag-'+e.category+(e.done?' done':'')+'" data-id="'+e.id+'"><span class="wk-t">'+e.time+'</span> '+_esc(e.title)+(e.onGoogle?' 📌':'')+'</div>';
    }).join('') || '<div class="wk-empty">—</div>';
    html+='<div class="wk-block'+(k===today?' today':'')+'"><div class="wk-day" onclick="goDay(\''+k+'\')">'+G[i]+' '+d.getDate()+'</div>'+items+'</div>';
  }
  body.innerHTML=html;
  // doppio tap su un giorno della settimana = nuovo evento in quel giorno
  Array.prototype.forEach.call(body.querySelectorAll('.wk-block'), function(blk){
    blk.addEventListener('dblclick', function(){ /* apre editor sul giorno del blocco */ });
  });
  // tap su una voce esistente = modifica
  Array.prototype.forEach.call(body.querySelectorAll('.wk-item[data-id]'), function(it){
    it.addEventListener('click', function(){ openEditor(it.getAttribute('data-id')); });
  });
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
    // nel mese mostro SOLO gli eventi importanti (quelli su Google Calendar)
    var items=(map[key]||[]).filter(function(e){ return e.onGoogle; });
    var evs=items.slice(0,3).map(function(e){ return '<div class="mo-ev tag-'+e.category+'"><span>'+_esc(e.title)+'</span></div>'; }).join('');
    if(items.length>3) evs+='<div class="mo-more">+'+(items.length-3)+'</div>';
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
// (frecce rimosse: navigazione tra date solo via swipe)
Array.prototype.forEach.call(document.querySelectorAll('.vbtn'),function(b){ b.onclick=function(){ _setView(b.getAttribute('data-view')); }; });

// ====== SWIPE orizzontale per navigare (avanti/indietro nella vista) ======
(function(){
  var x0=null,y0=null,t0=0;
  var el=document.getElementById('page');
  el.addEventListener('touchstart', function(e){ var t=e.touches[0]; x0=t.clientX; y0=t.clientY; t0=Date.now(); }, {passive:true});
  el.addEventListener('touchend', function(e){
    if(x0===null) return;
    var t=e.changedTouches[0]; var dx=t.clientX-x0, dy=t.clientY-y0;
    x0=null;
    // swipe valido: orizzontale dominante, abbastanza ampio, abbastanza rapido
    if(Math.abs(dx)>60 && Math.abs(dx)>Math.abs(dy)*1.8 && (Date.now()-t0)<600){
      _shiftAnchor(dx<0 ? 1 : -1);   // sx = avanti, dx = indietro
    }
  }, {passive:true});
})();

// ====== DONE (ottimistico) ======
function toggleDone(id){
  var e=cache.entries.find(function(x){ return x.id===id; }); if(!e) return;
  e.done=!e.done; _markPending(id); _saveCache(); render();          // UI subito
  apiPost({ action:'updateEntry', entry:e })
    .then(function(saved){ _clearPending(id); if(saved){ _upsert(saved); } })
    .catch(function(err){ console.warn('save done bg:', err.message); });   // resta pending → riprovabile, non perso
}

// ====== EDITOR ======
function _renderCats(){
  document.getElementById('ed-cats').innerHTML = CATS.map(function(c){
    return '<button class="ed-cat tag-'+c+(c===state.selCat?' sel':'')+'" onclick="selCat(\''+c+'\')"><span>'+c+'</span></button>';
  }).join('');
}
function selCat(c){ state.selCat=c; _renderCats(); }
function openEditor(id){
  state.editing=null; state.selCat='lavoro'; state.fromPostitId=null;
  document.getElementById('ed-title').value='';
  document.getElementById('ed-time').value='';
  document.getElementById('ed-date').value=state.anchor;   // default: giorno corrente
  document.getElementById('ed-google').checked=false;
  if(id){
    var e=cache.entries.find(function(x){ return x.id===id; });
    if(e){ state.editing=e; state.selCat=e.category||'lavoro';
      document.getElementById('ed-title').value=e.title;
      document.getElementById('ed-time').value=e.time;
      document.getElementById('ed-date').value=e.date;
      document.getElementById('ed-google').checked=!!e.onGoogle; }
  }
  _renderCats();
  document.getElementById('ed-delete').classList.toggle('hidden', !id);
  document.getElementById('ed-topostit').classList.toggle('hidden', !id);  // "Al post-it" solo in modifica
  document.getElementById('editor').classList.remove('hidden');
  setTimeout(function(){ document.getElementById('ed-title').focus(); },80);
}
function closeEditor(){ document.getElementById('editor').classList.add('hidden'); }

function saveEntry(){
  var title=document.getElementById('ed-title').value.trim();
  var time=document.getElementById('ed-time').value;
  var date=document.getElementById('ed-date').value || state.anchor;   // data scelta (sposta evento)
  if(!title){ alert('Scrivi cosa'); return; }
  if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)){ alert('Orario obbligatorio'); return; }
  var entry={ date:date, time:time, title:title, category:state.selCat,
    onGoogle:document.getElementById('ed-google').checked,
    done:(state.editing&&state.editing.done)||false };
  if(state.editing){
    entry.id=state.editing.id; entry.eventId=state.editing.eventId; entry.linkedNoteId=state.editing.linkedNoteId||'';
    _markPending(entry.id); _upsert(entry); render(); closeEditor();          // UI subito
    apiPost({ action:'updateEntry', entry:entry })
      .then(function(saved){ _clearPending(entry.id); if(saved){ _upsert(saved); } })
      .catch(function(e){ console.warn('upd bg:',e.message); });              // resta pending → non perso
  } else {
    // id provvisorio locale; il server ne assegna uno definitivo
    var tmpId='tmp_'+Date.now()+Math.random().toString(36).slice(2,6);
    entry.id=tmpId; entry.eventId='';
    _markPending(tmpId); _upsert(entry); render(); closeEditor();             // UI subito
    // se l'evento nasce da un item del post-it: ora che è salvato, l'item sparisce
    // dalla lista d'origine (main o una temp)
    if(state.fromPostitId){
      var src = state.fromPostitList && state.fromPostitList!=='main'
        ? tempLists.filter(function(l){return l.id===state.fromPostitList;})[0] : postit;
      if(src){ src.items=src.items.filter(function(i){return i.id!==state.fromPostitId;});
        if(src===postit){ _savePostitLocal(); _pushNote(); } else { _saveTempLocal(); _renderTabs(); } }
      state.fromPostitId=null; state.fromPostitList=null;
    }
    var toSend=Object.assign({},entry); delete toSend.id;
    apiPost({ action:'addEntry', entry:toSend })
      .then(function(saved){ _removeLocal(tmpId); if(saved){ _upsert(saved); } render(); })
      .catch(function(e){ console.warn('add bg:',e.message); });              // tmp resta pending → visibile, non perso
  }
}
function deleteCurrent(){
  if(!state.editing) return;
  if(!confirm('Eliminare?')) return;
  var id=state.editing.id;
  var e=cache.entries.find(function(x){ return x.id===id; });
  if(e){ e._deleted=true; } _markPending(id); _saveCache(); render(); closeEditor();   // UI subito (nascosta)
  apiPost({ action:'deleteEntry', id:id })
    .then(function(){ _removeLocal(id); })                                    // confermato: via davvero
    .catch(function(err){ console.warn('del bg:',err.message); });           // resta pending → riprovabile
}
// sposta un evento dell'agenda nel post-it (diventa una cosa-da-fare generica) e lo rimuove dall'agenda
function entryToPostit(){
  if(!state.editing) return;
  var e=state.editing;
  postit.items.unshift({ id:'n'+Date.now().toString(36)+Math.random().toString(36).slice(2,5), text:e.title, done:false });
  _savePostitLocal(); _pushNote();
  // rimuovi l'evento dall'agenda (e da Calendar se sincronizzato), come la delete
  var id=e.id; var c=cache.entries.find(function(x){ return x.id===id; });
  if(c){ c._deleted=true; } _markPending(id); _saveCache(); render(); closeEditor();
  apiPost({ action:'deleteEntry', id:id }).then(function(){ _removeLocal(id); }).catch(function(err){ console.warn('toPostit del bg:',err.message); });
}

// ====== POST-IT (lista di cose da fare generiche) ======
// modello main (sincronizzato col backend): { color, items:[ {id, text, done} ] }
var postit = { color:POSTIT_COLORS[0], items:[] };
// liste usa-e-getta SOLO LOCALI (max 2): [{ id, items:[{id,text,done}] }].
// Nate via swipe a destra dal post-it main; si "bruciano" quando l'ultimo item è spuntato.
var MAX_TEMP = 2;
var tempLists = [];
// quale post-it è aperto/attivo nel modal: 'main' oppure un id di tempList.
var activePostit = 'main';

function _loadPostit(){
  try{ var p=JSON.parse(localStorage.getItem('ql_postit')||'null'); if(p&&p.items){ postit=p; } }catch(e){}
  if(!postit.color) postit.color=POSTIT_COLORS[0];
  document.documentElement.style.setProperty('--postit', postit.color);
  try{ var t=JSON.parse(localStorage.getItem('ql_templists')||'null'); if(t&&t.length) tempLists=t; }catch(e){}
  _renderTabs();
}
function _savePostitLocal(){ try{ localStorage.setItem('ql_postit', JSON.stringify(postit)); }catch(e){} }
function _saveTempLocal(){ try{ localStorage.setItem('ql_templists', JSON.stringify(tempLists)); }catch(e){} }
function _pushNote(){ apiPost({ action:'setNote', note:postit }).catch(function(e){ console.warn('note bg:',e.message); }); }

// ritorna l'oggetto-lista attivo (main o temp). main ha .color, temp no.
function _active(){
  if(activePostit==='main') return postit;
  return tempLists.filter(function(l){ return l.id===activePostit; })[0] || postit;
}
function _isTemp(){ return activePostit!=='main'; }
// persiste la lista attiva (sul backend solo se è il main)
function _persistActive(){
  if(_isTemp()){ _saveTempLocal(); }
  else { _savePostitLocal(); _pushNote(); }
}

function openPostit(){
  activePostit='main';
  _openActive();
  // versione fresca del main dal server in bg (ridisegna solo se cambiata e ancora sul main)
  var before=JSON.stringify(postit);
  apiGet({ action:'getNote' }).then(function(d){
    if(d&&d.items){ postit={ color:d.color||postit.color, items:d.items }; _savePostitLocal();
      if(JSON.stringify(postit)!==before && activePostit==='main' && !document.getElementById('postit-modal').classList.contains('hidden')){
        document.documentElement.style.setProperty('--postit', postit.color); renderPostit();
      }
    }
  }).catch(function(){});
}
// apre il temp post-it con un dato id
function openTemp(id){ activePostit=id; _openActive(); }
// apre il modal sul post-it attivo (main o temp), impostando aspetto e contenuto
function _openActive(){
  var modal=document.getElementById('postit-modal');
  var box=document.getElementById('postit');
  box.classList.remove('burning');   // pulizia difensiva se un burn è stato interrotto
  if(_isTemp()){
    box.classList.add('temp');
    document.getElementById('postit-colors').innerHTML='';   // i temp non hanno colori
  } else {
    box.classList.remove('temp');
    document.documentElement.style.setProperty('--postit', postit.color);
    document.getElementById('postit-colors').innerHTML = POSTIT_COLORS.map(function(c){
      return '<button style="background:'+c+'" onclick="setPostitColor(\''+c+'\')"></button>';
    }).join('');
  }
  renderPostit();
  modal.classList.remove('hidden');
  setTimeout(function(){ document.getElementById('postit-input').focus(); }, 80);
}
function closePostit(){
  // un temp ancora vuoto sarebbe inutile, ma lo conserviamo (può riaprirlo dal tab)
  document.getElementById('postit-modal').classList.add('hidden');
  activePostit='main';
}
function setPostitColor(c){ postit.color=c; document.documentElement.style.setProperty('--postit',c); _savePostitLocal(); _pushNote(); }

// ordina: prima i non fatti, poi i fatti (in fondo, come traccia)
function _piOrdered(){
  var items=_active().items;
  var todo=items.filter(function(i){return !i.done;});
  var done=items.filter(function(i){return i.done;});
  return todo.concat(done);
}
function renderPostit(){
  var list=document.getElementById('postit-list');
  var items=_active().items;
  if(!items.length){
    var hint=_isTemp() ? 'Lista al volo. Scrivi sopra e premi invio.' : 'Niente ancora. Scrivi sopra e premi invio.';
    list.innerHTML='<div style="opacity:.45;font-style:italic;padding:10px 2px">'+hint+'</div>'; return;
  }
  list.innerHTML = _piOrdered().map(function(it){
    return '<div class="pi-item'+(it.done?' done':'')+'" data-id="'+it.id+'">'
      +'<span class="pi-check" data-act="toggle"></span>'
      +'<span class="pi-text" data-act="tap">'+_esc(it.text)+'</span>'
      +'<span class="pi-del">🗑</span></div>';
  }).join('');
  Array.prototype.forEach.call(list.querySelectorAll('.pi-item'), _wirePiItem);
}
function addPostitItem(text){
  text=text.trim(); if(!text) return;
  _active().items.unshift({ id:'n'+Date.now().toString(36)+Math.random().toString(36).slice(2,5), text:text, done:false });
  _persistActive(); renderPostit(); _renderTabs();
}
document.getElementById('postit-input').addEventListener('keydown', function(e){
  if(e.key==='Enter'){ e.preventDefault(); addPostitItem(this.value); this.value=''; }
});

// SWIPE A DESTRA sul post-it (solo dal MAIN) → crea una lista usa-e-getta.
// Gesto orizzontale chiaro per non confliggere con lo scroll verticale della lista.
(function(){
  var box=document.getElementById('postit');
  var x0=null,y0=null,horiz=false;
  box.addEventListener('touchstart', function(e){ x0=e.touches[0].clientX; y0=e.touches[0].clientY; horiz=false; }, {passive:true});
  box.addEventListener('touchmove', function(e){
    if(x0===null) return;
    var dx=e.touches[0].clientX-x0, dy=e.touches[0].clientY-y0;
    if(!horiz && Math.abs(dx)>14 && Math.abs(dx)>Math.abs(dy)*1.6) horiz=true;
    if(horiz && dx>0 && activePostit==='main'){ box.style.transform='rotate(-1deg) translateX('+Math.min(dx,70)+'px)'; }
  }, {passive:true});
  box.addEventListener('touchend', function(e){
    if(horiz && activePostit==='main'){
      var dx=e.changedTouches[0].clientX-x0;
      box.style.transform='';
      if(dx>70){
        if(!_createTemp()){ box.classList.add('shake'); setTimeout(function(){ box.classList.remove('shake'); },350); }
      }
    }
    x0=null;y0=null;horiz=false;
  }, {passive:true});
})();
// fallback desktop/test: doppio click sul post-it main crea una lista al volo
document.getElementById('postit').addEventListener('dblclick', function(){
  if(activePostit==='main') _createTemp();
});

// item: tap su check = toggle fatto; tap su testo = modal scelta; swipe sx = elimina (se fatto)
function _wirePiItem(el){
  var id=el.getAttribute('data-id');
  el.addEventListener('click', function(ev){
    var act=ev.target.getAttribute('data-act');
    if(act==='toggle') piToggle(id);
    else if(act==='tap') piOpenChoice(id);
  });
  // swipe-to-delete (solo orizzontale)
  var x0=null,sw=false;
  el.addEventListener('touchstart', function(e){ x0=e.touches[0].clientX; sw=false; }, {passive:true});
  el.addEventListener('touchmove', function(e){
    if(x0===null) return; var dx=e.touches[0].clientX-x0;
    if(dx<-10){ sw=true; el.classList.add('swiping'); el.style.transform='translateX('+Math.max(dx,-90)+'px)';
      el.querySelector('.pi-del').style.opacity=Math.min(1,-dx/70); }
  }, {passive:true});
  el.addEventListener('touchend', function(e){
    if(sw){ var dx=e.changedTouches[0].clientX-x0;
      if(dx<-60){ piDelete(id); return; }
      el.style.transform=''; el.querySelector('.pi-del').style.opacity=0; }
    x0=null;
  }, {passive:true});
}
function _piFind(id){ return _active().items.filter(function(i){return i.id===id;})[0]; }
function piToggle(id){
  var it=_piFind(id); if(!it) return; it.done=!it.done; _persistActive(); renderPostit(); _renderTabs();
  // temp list: se tutti gli item sono ora spuntati → si brucia e sparisce
  if(_isTemp()){
    var items=_active().items;
    if(items.length && items.every(function(i){return i.done;})) _burnActiveTemp();
  }
}
function piDelete(id){
  var a=_active(); a.items=a.items.filter(function(i){return i.id!==id;});
  _persistActive(); renderPostit(); _renderTabs();
}

// ---- modal scelta su item ----
var piChoiceId=null;
function piOpenChoice(id){
  var it=_piFind(id); if(!it) return;
  piChoiceId=id;
  document.getElementById('pi-choice-text').value=it.text;   // testo modificabile
  document.getElementById('pi-choice').classList.remove('hidden');
}
// salva nell'item il testo eventualmente modificato nell'input del modal
function _piSyncText(){
  var it=_piFind(piChoiceId); if(!it) return it;
  var t=document.getElementById('pi-choice-text').value.trim();
  if(t && t!==it.text){ it.text=t; _persistActive(); }
  return it;
}
function piCloseChoice(){ _piSyncText(); renderPostit(); _renderTabs(); document.getElementById('pi-choice').classList.add('hidden'); piChoiceId=null; }
function piMarkDone(){
  var it=_piSyncText(); document.getElementById('pi-choice').classList.add('hidden');
  if(it){ it.done=true; _persistActive(); renderPostit(); _renderTabs();
    if(_isTemp()){ var items=_active().items; if(items.length && items.every(function(i){return i.done;})) _burnActiveTemp(); }
  }
  piChoiceId=null;
}
function piToAgenda(){
  var it=_piSyncText(); if(!it){ piCloseChoice(); return; }
  var pendingId=it.id; var fromList=activePostit;
  piCloseChoice(); closePostit();
  // apre editor nuovo evento di OGGI col "cosa?" precompilato; l'item sparisce SOLO se salvo
  openEditor();
  state.anchor=_todayISO();
  document.getElementById('ed-title').value=it.text;
  // memorizza quale item (e da quale lista) rimuovere dopo il salvataggio
  state.fromPostitId=pendingId; state.fromPostitList=fromList;
}

// ---- liste usa-e-getta (temp) ----
// Le linguette dei temp si impilano sopra .note-btn, una per lista, cliccabili.
function _renderTabs(){
  var wrap=document.getElementById('temp-tabs'); if(!wrap) return;
  wrap.innerHTML = tempLists.map(function(l){
    var n=l.items.filter(function(i){return !i.done;}).length;
    return '<button class="temp-tab" onclick="openTemp(\''+l.id+'\')" title="Lista al volo">'
      + (n? '<span class="temp-tab-n">'+n+'</span>' : '') + '</button>';
  }).join('');
}
// crea una nuova lista usa-e-getta (se c'è spazio) e la apre
function _createTemp(){
  if(tempLists.length>=MAX_TEMP) return false;
  var id='tl'+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  tempLists.push({ id:id, items:[] });
  _saveTempLocal(); _renderTabs();
  openTemp(id);
  return true;
}
// "brucia" il temp attivo: animazione bottom→top, poi rimozione e chiusura modal
function _burnActiveTemp(){
  var id=activePostit;
  var box=document.getElementById('postit');
  box.classList.add('burning');
  setTimeout(function(){
    tempLists=tempLists.filter(function(l){return l.id!==id;});
    _saveTempLocal(); _renderTabs();
    box.classList.remove('burning','temp');
    document.getElementById('postit-modal').classList.add('hidden');
    activePostit='main';
  }, 1150);   // deve combaciare con la durata di @keyframes burn
}

// ====== TRACKING (report a fasce + voti) ======
// fasce: devono combaciare con TRK_SLOTS del backend
var TK_SLOTS = ['06:00-08:30','08:30-15:00','15:00-16:00','16:00-17:00','17:00-19:00','19:00-21:00','21:00-24:00'];
var tkState = { date:null, bySlot:{} };

// la fascia è "passata" se l'ora di FINE è già trascorsa (solo per oggi; giorni passati = tutte passate)
function _slotEnd(slot){ var h=slot.split('-')[1].split(':'); return (+h[0])*60+(+h[1]); }
function _isPast(slot, date){
  if(date < _todayISO()) return true;
  if(date > _todayISO()) return false;
  var now=new Date(); return (now.getHours()*60+now.getMinutes()) >= _slotEnd(slot);
}

// cache locale del tracking per giorno (così il bookmark NON è vuoto per 4s)
function _trkCacheGet(date){ try{ return JSON.parse(localStorage.getItem('ql_trk_'+date)||'null'); }catch(e){ return null; } }
function _trkCacheSet(date, bySlot){ try{ localStorage.setItem('ql_trk_'+date, JSON.stringify(bySlot)); }catch(e){} }

function openTracking(){
  tkState.date = state.anchor;
  tkState.bySlot = _trkCacheGet(tkState.date) || {};   // subito dalla cache (niente vuoto)
  document.getElementById('tracking').classList.remove('hidden');
  renderTracking();
  apiGet({ action:'getTracking', date:tkState.date }).then(function(d){
    var fresh={}; (d&&d.entries||[]).forEach(function(e){ fresh[e.slot]=e; });
    // ridisegna solo se cambiato (evita il refresh/flicker inutile)
    if(JSON.stringify(fresh)!==JSON.stringify(tkState.bySlot)){
      tkState.bySlot=fresh; _trkCacheSet(tkState.date, fresh); renderTracking();
    }
  }).catch(function(e){ console.warn('tracking get bg:',e.message); });
}
function closeTracking(){ document.getElementById('tracking').classList.add('hidden'); }

function renderTracking(){
  var p=tkState.date.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
  var oggi = tkState.date===_todayISO();
  document.getElementById('tk-title').innerHTML = '<span>'+d.getDate()+' '+MESI[d.getMonth()].toUpperCase()+'</span><span class="sub">'+(oggi?'i voti di oggi':'voti del giorno')+'</span>';
  var html='';
  TK_SLOTS.forEach(function(slot){
    var rec=tkState.bySlot[slot];
    var past=_isPast(slot, tkState.date);
    if(rec && (rec.pleasure!=null || rec.utility!=null || rec.activity)){
      var votes='';
      if(rec.pleasure!=null) votes+='<span class="tk-v p">'+emojiP(rec.pleasure)+' '+rec.pleasure+'</span>';
      if(rec.utility!=null)  votes+='<span class="tk-v u">'+emojiU(rec.utility)+' '+rec.utility+'</span>';
      html+='<div class="tk-slot" onclick="openRate(\''+slot+'\')"><div class="tk-time">'+slot.replace('-',' – ')+'</div><div class="tk-act">'+_esc(rec.activity||'(senza nota)')+'</div><div class="tk-votes">'+votes+'</div></div>';
    } else if(past){
      html+='<div class="tk-slot" onclick="openRate(\''+slot+'\')"><div class="tk-time">'+slot.replace('-',' – ')+'</div><div class="tk-act empty">da votare…</div><div class="tk-votes"><span class="tk-add">+</span></div></div>';
    } else {
      html+='<div class="tk-slot future"><div class="tk-time">'+slot.replace('-',' – ')+'</div><div class="tk-act empty">— non ancora</div></div>';
    }
  });
  document.getElementById('tk-slots').innerHTML=html;
}

function emojiP(v){ return v<=2?'💀':v<=4?'😩':v<=6?'😐':v<=8?'😎':'🔥'; }
function emojiU(v){ return v<=2?'🗑️':v<=4?'🤏':v<=6?'👍':v<=8?'💪':'🚀'; }

// ---- effetto bookmark: pulsa se OGGI ci sono fasce passate non votate ----
function _slotVoted(rec){ return rec && (rec.pleasure!=null || rec.utility!=null || rec.activity); }
function refreshBookmarkBadge(){
  var bm=document.getElementById('bookmark'); if(!bm) return;
  var bySlot = _trkCacheGet(_todayISO()) || {};
  var arretrate = TK_SLOTS.filter(function(s){ return _isPast(s, _todayISO()) && !_slotVoted(bySlot[s]); }).length;
  bm.classList.toggle('pending', arretrate>0);
  bm.setAttribute('data-count', arretrate>0 ? arretrate : '');
}

// ====== MODAL 3-STEP (lazy) ======
var rateState = { slot:null, step:1, timer:null, rec:null };
function openRate(slot){
  rateState.slot=slot; rateState.step=1;
  rateState.rec = tkState.bySlot[slot] || { date:tkState.date, slot:slot, activity:'', pleasure:null, utility:null };
  document.getElementById('rate-slot').textContent = slot.replace('-',' – ');
  document.getElementById('rate-act').value = rateState.rec.activity||'';
  document.getElementById('rate-pleasure').value = rateState.rec.pleasure||5;
  document.getElementById('rate-utility').value = rateState.rec.utility||5;
  _rateShowStep(1);
  document.getElementById('rate').classList.remove('hidden');
  setTimeout(function(){ document.getElementById('rate-act').focus(); }, 80);
}
function _rateShowStep(n){
  rateState.step=n;
  [1,2,3].forEach(function(i){ document.getElementById('rate-step'+i).classList.toggle('hidden', i!==n); });
  var dots=document.querySelectorAll('.rate-dots .rd');
  dots.forEach(function(dt,i){ dt.classList.toggle('on', i<n); });
  _rateProg(0);
  if(n===2){ _rateEmoji('p'); }
  if(n===3){ _rateEmoji('u'); }
}
function _rateEmoji(which){
  if(which==='p'){ var v=+document.getElementById('rate-pleasure').value; document.getElementById('rate-pleasure-val').textContent=v; document.getElementById('rate-emoji-p').textContent=emojiP(v); }
  else { var u=+document.getElementById('rate-utility').value; document.getElementById('rate-utility-val').textContent=u; document.getElementById('rate-emoji-u').textContent=emojiU(u); }
}
// barra di avanzamento (riempie in 2s; a fine → step successivo)
function _rateProg(reset){
  var bar=document.getElementById('rate-prog-bar');
  if(rateState.timer){ clearTimeout(rateState.timer); rateState.timer=null; }
  bar.style.transition='none'; bar.style.width='0%';
  if(reset) return; // step1: nessun auto-avanzamento (si avanza con Invio)
}
function _rateArm(){
  // chiamata a ogni movimento slider: resetta e riavvia il conto di 2s
  var bar=document.getElementById('rate-prog-bar');
  if(rateState.timer) clearTimeout(rateState.timer);
  bar.style.transition='none'; bar.style.width='0%';
  void bar.offsetWidth; // reflow
  bar.style.transition='width 2s linear'; bar.style.width='100%';
  rateState.timer=setTimeout(function(){ _rateAdvance(); }, 2000);
}
function _rateAdvance(){
  if(rateState.step===2){ rateState.rec.pleasure=+document.getElementById('rate-pleasure').value; _rateShowStep(3); }
  else if(rateState.step===3){ rateState.rec.utility=+document.getElementById('rate-utility').value; _rateSaveClose(); }
}
function _rateSaveClose(){
  if(rateState.timer) clearTimeout(rateState.timer);
  var rec=rateState.rec;
  tkState.bySlot[rec.slot]=rec; _trkCacheSet(tkState.date, tkState.bySlot);   // UI + cache subito
  document.getElementById('rate').classList.add('hidden');
  renderTracking(); refreshBookmarkBadge();
  apiPost({ action:'setTracking', rec:rec }).then(function(saved){ if(saved){ tkState.bySlot[saved.slot]=saved; _trkCacheSet(tkState.date, tkState.bySlot); } }).catch(function(e){ console.warn('tracking save bg:',e.message); });
}
// wiring eventi del modal rate
document.getElementById('rate-act').addEventListener('keydown', function(e){
  if(e.key==='Enter'){ e.preventDefault(); rateState.rec.activity=this.value.trim(); _rateShowStep(2); /* niente _rateArm: il timer parte solo quando muovi lo slider */ }
});
document.getElementById('rate-pleasure').addEventListener('input', function(){ _rateEmoji('p'); _rateArm(); });
document.getElementById('rate-utility').addEventListener('input', function(){ _rateEmoji('u'); _rateArm(); });
// chiusura tappando lo sfondo: conferma se incompleto
document.getElementById('rate').addEventListener('click', function(e){
  if(e.target!==this) return; // solo click sullo sfondo
  if(rateState.timer) clearTimeout(rateState.timer);
  var partial = (rateState.step<3) || rateState.rec.utility==null;
  if(partial){ if(!confirm('Salvare quello che hai messo finora?')){ document.getElementById('rate').classList.add('hidden'); return; } }
  if(rateState.step>=2) rateState.rec.pleasure=+document.getElementById('rate-pleasure').value;
  if(rateState.step>=3) rateState.rec.utility=+document.getElementById('rate-utility').value;
  rateState.rec.activity=document.getElementById('rate-act').value.trim();
  _rateSaveClose();
});

// ====== service worker (PWA) ======
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(e){ console.warn('SW:', e); }); });
}

boot();
