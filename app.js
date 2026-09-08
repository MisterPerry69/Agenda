// ====== CONFIG ======
// URL del Web App di Apps Script (deve finire con /exec). Vedi README per il deploy.
var SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyfK9M2FA9oI-iCyUyCKg5aJZu6bK1V5lz5YcyQ3CoAXmksEGBXN3Wqm8kRMEMONvio/exec';

// categorie: chiave interna salvata nel foglio | emoji | etichetta
var CATS = [
  { key:'work',   emoji:'💼', label:'Work' },
  { key:'casa',   emoji:'🏠', label:'Casa' },
  { key:'social', emoji:'❤️', label:'Social' },
  { key:'health', emoji:'⚕️', label:'Health' },
  { key:'admin',  emoji:'📋', label:'Admin' },
  { key:'hobby',  emoji:'🎯', label:'Hobby' },
  { key:'gym',    emoji:'🏋️', label:'Gym' }
];
// categorie mostrate in modalità ricorrente (editor is-recurring)
var REC_CATS = [
  { key:'admin',    emoji:'📋', label:'Admin' },
  { key:'birthday', emoji:'🎂', label:'Birthday' },
  { key:'gym',      emoji:'🏋️', label:'Gym' }
];
// mappa vecchie categorie (lavoro/casa/libero/cazzeggio) -> nuove chiavi, a sola VISTA
var CAT_MIGRATE = { lavoro:'work', casa:'casa', libero:'hobby', cazzeggio:'social' };
function _catKey(raw){ var k=String(raw||''); return CAT_MIGRATE[k] || k; }
function _catDef(raw){
  var k=_catKey(raw);
  for(var i=0;i<CATS.length;i++){ if(CATS[i].key===k) return CATS[i]; }
  for(var j=0;j<REC_CATS.length;j++){ if(REC_CATS[j].key===k) return REC_CATS[j]; }
  return null;
}
// HTML del tag categoria per le viste (emoji + etichetta evidenziata); fallback neutro
function _catTag(raw){
  var d=_catDef(raw);
  if(!d) return '<span class="ag-tag tag-unknown" data-act="edit"><span>'+_esc(String(raw||'?'))+'</span></span>';
  return '<span class="ag-tag tag-'+d.key+'" data-act="edit"><span>'+d.emoji+' '+d.label+'</span></span>';
}
var POSTIT_COLORS = ['#ff93cf','#fff04d','#84d2ff','#a7ef5e','#ffb27a'];

var state = { view:'day', anchor:_todayISO(), editing:null, selCat:'work' };

// ====== CACHE LOCALE (fruizione immediata) ======
// Tutte le voci stanno in cache; le viste leggono da qui (istantanee).
// La cache si popola dietro la cover e si riallinea col backend in background.
// `pending`: id di voci con una scrittura non ancora confermata dal server.
// Il sync NON deve mai cancellarle (altrimenti "inserisco e ricaricando sparisce").
// loadedMonths: insieme (oggetto usato come Set) delle chiavi 'yyyy-MM' già
// scaricate dal server almeno una volta. Traccia la copertura per singolo mese
// (non un unico intervallo continuo) così eventuali "buchi" nella cronologia di
// caricamento non vengono mai scambiati per range coperti (vedi _ensureRangeLoaded).
var cache = { entries: [], pending: [], loadedAt: 0, loadedMonths: {} };
function _loadCache(){
  try{ var c = JSON.parse(localStorage.getItem('ql_cache')||'null'); if(c&&c.entries){ cache=c; if(!cache.pending) cache.pending=[];
    if(!cache.loadedMonths) cache.loadedMonths={}; } }catch(e){}
}
function _saveCache(){ try{ localStorage.setItem('ql_cache', JSON.stringify(cache)); }catch(e){} }
function _markPending(id){ if(cache.pending.indexOf(id)<0) cache.pending.push(id); }
function _clearPending(id){ cache.pending = cache.pending.filter(function(x){ return x!==id; }); }
// chiave d'ordine: i todo (time vuoto) vanno DOPO le voci con orario, nello stesso giorno
function _sortKey(e){ return e.date + (e.time ? e.time : '99:99'); }
// un evento occupa più giorni?
function _isMulti(e){ return !!e.dateEnd && e.dateEnd > e.date; }
// todo vero = niente orario, non multi-giorno, e non è un all-day di una serie
// ricorrente (quello ha semplicemente time vuoto per design, non è "da fare").
function _isTodoEntry(e){ return !e.time && !_isMulti(e) && !e.allDay; }
// posizione dell'evento nel giorno k: 'single' | 'start' | 'mid' | 'end'
function _dayPos(e, k){
  if(!_isMulti(e)) return 'single';
  if(k===e.date) return 'start';
  if(k===e.dateEnd) return 'end';
  return 'mid';
}
// etichetta orario/marcatore da mostrare nel giorno k
function _dayTimeLabel(e, k){
  if(_isTodoEntry(e)) return 'todo';
  if(!e.time && !_isMulti(e)) return 'tutto il giorno';   // ricorrenza all-day
  var pos=_dayPos(e,k);
  if(pos==='single') return e.time + (e.timeEnd?('–'+e.timeEnd):'');
  if(pos==='start')  return '▶ '+(e.time||'');
  if(pos==='end')    return '◀ '+(e.timeEnd||'');
  return '⋯';
}
// intersezione col range (così le viste vedono i multi-giorno che entrano da prima)
function _entriesIn(from,to){
  return cache.entries.filter(function(e){
    if(e._deleted) return false;
    var s=e.date, en=e.dateEnd||e.date;
    return s<=to && en>=from;
  }).sort(function(a,b){ return _sortKey(a)<_sortKey(b)?-1:1; });
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
  loadActivities();   // storico attività per l'autocomplete dei voti
}
// chiave di contenuto per riconoscere una pending già confermata sul server
// (stessa data+ora+titolo) anche se l'id locale (tmp_...) non corrisponde più:
// succede quando la risposta di addEntry/updateEntry non torna mai al client
// (app chiusa/sospesa a metà richiesta su mobile) ma il salvataggio è comunque
// andato a buon fine lato GAS.
function _contentKey(e){ return e.date+'|'+e.time+'|'+e.title; }
// tutte le chiavi 'yyyy-MM' toccate da [from,to], per marcarle come scaricate
function _monthKeysBetween(from, to){
  var keys=[]; var p=from.split('-'); var d=new Date(+p[0],+p[1]-1,1);
  var end=to.split('-'); var endD=new Date(+end[0],+end[1]-1,1);
  while(d<=endD){ keys.push(d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)); d.setMonth(d.getMonth()+1); }
  return keys;
}
function syncRange(from,to){
  var before = JSON.stringify(cache.entries);
  apiGet({ action:'getAgenda', from:from, to:to })
    .then(function(rows){
      var freshKeys = {};
      (rows||[]).forEach(function(r){ freshKeys[_contentKey(r)]=true; });
      // rimpiazza le voci dell'intervallo con quelle del server,
      // MA conserva quelle ancora "pending" (scrittura non confermata) —
      // a meno che il server non mostri già una voce equivalente: in tal
      // caso la pending è un doppione fantasma (conferma persa) e va scartata.
      var keep = cache.entries.filter(function(e){
        if(cache.pending.indexOf(e.id)>=0){
          if(freshKeys[_contentKey(e)]){ _clearPending(e.id); return false; }
          return true;
        }
        var en = e.dateEnd || e.date;                           // intersezione, non solo e.date
        return en<from || e.date>to;                            // fuori intervallo: resta
      });
      cache.entries = keep.concat(rows||[]);
      cache.loadedAt = Date.now();
      _monthKeysBetween(from,to).forEach(function(k){ cache.loadedMonths[k]=true; });
      _saveCache();
      // ridisegna SOLO se i dati sono davvero cambiati → niente flicker/refresh inutile
      if(JSON.stringify(cache.entries)!==before) render();
      _checkSeriesRenewal();
    })
    .catch(function(e){ console.warn('sync fallita (uso cache):', e.message); });
}
// se la vista richiesta tocca mesi mai scaricati (es. navighi 2+ anni avanti su
// una serie ricorrente lunga), li scarica al volo. Fix del bug "impegno sparito
// nel futuro lontano": il dato esiste sul server, semplicemente il client non
// l'aveva ancora richiesto perché fuori dalla finestra di caricamento iniziale.
function _ensureRangeLoaded(from, to){
  var missing = _monthKeysBetween(from,to).filter(function(k){ return !cache.loadedMonths[k]; });
  if(missing.length) syncRange(from, to);
}

// ====== RINNOVO SERIE RICORRENTI ======
// Calcolato SEMPRE lato server (getSeriesNeedingRenewal legge l'intero sheet):
// la cache locale copre solo una finestra di date, quindi ragionare sull'ultima
// occorrenza vista dal client porterebbe a valutare la riga sbagliata per serie
// più lunghe della finestra caricata (bug corretto: il popup non si placava mai).
var _renewQueue = [];
var _renewShowing = null;

function _checkSeriesRenewal(){
  apiGet({ action:'getSeriesNeedingRenewal' }).then(function(list){
    _renewQueue = list||[];
    _showNextRenewPrompt();
  }).catch(function(e){ console.warn('checkSeriesRenewal bg:',e.message); });
}
function _showNextRenewPrompt(){
  if(_renewShowing || !_renewQueue.length) return;
  _renewShowing = _renewQueue.shift();
  document.getElementById('renew-title').textContent =
    'La ricorrenza «'+_renewShowing.title+'» è arrivata alla fine: generare altre occorrenze?';
  document.getElementById('renew-modal').classList.remove('hidden');
}
function renewConfirm(){
  var last=_renewShowing;
  document.getElementById('renew-modal').classList.add('hidden'); _renewShowing=null;
  if(!last) return;
  var count = last.freq==='year' ? 40 : 12;
  apiPost({ action:'renewSeries', seriesId:last.seriesId, count:count })
    .then(function(created){
      // le nuove occorrenze potrebbero cadere fuori dalla finestra già in cache:
      // aggiungile solo se il mese è già coperto, altrimenti la prossima
      // navigazione lì le scaricherà da sola via _ensureRangeLoaded.
      (created||[]).forEach(function(e){
        var mk=e.date.slice(0,7);
        if(cache.loadedMonths[mk]) _upsert(e);
      });
      render(); _showNextRenewPrompt();
    })
    .catch(function(e){ console.warn('renew bg:',e.message); _showNextRenewPrompt(); });
}
function renewDecline(){
  var last=_renewShowing;
  document.getElementById('renew-modal').classList.add('hidden'); _renewShowing=null;
  if(!last) return;
  apiPost({ action:'declineSeries', seriesId:last.seriesId })
    .then(function(){ _showNextRenewPrompt(); })
    .catch(function(e){ console.warn('decline bg:',e.message); _showNextRenewPrompt(); });
}

// ====== PLAN MAKER ("Organizza la giornata") ======
// stato locale della bozza corrente (array di {title,time,category,isTodo}); null finché non generata.
var planDraft = null;

function openPlanModal(){
  document.getElementById('plan-text').value='';
  planDraft = null;
  document.getElementById('plan-input-state').classList.remove('hidden');
  document.getElementById('plan-draft-state').classList.add('hidden');
  document.getElementById('plan-generate-btn').disabled=false;
  document.getElementById('plan-generate-btn').textContent='Genera';
  document.getElementById('plan-modal').classList.remove('hidden');
}
function closePlanModal(){
  document.getElementById('plan-modal').classList.add('hidden');
  planDraft = null;
}
function _planBackToInput(){
  planDraft = null;
  document.getElementById('plan-input-state').classList.remove('hidden');
  document.getElementById('plan-draft-state').classList.add('hidden');
}

function generatePlan(){
  var text = document.getElementById('plan-text').value.trim();
  if(!text){ alert('Scrivi qualcosa'); return; }
  var btn = document.getElementById('plan-generate-btn');
  btn.disabled=true; btn.textContent='Sto organizzando…';
  var r = _rangeFor('day', state.anchor);
  var existing = _entriesIn(r.from, r.to).map(function(e){ return { title:e.title, time:e.time }; });
  apiPost({ action:'planDay', text:text, date:state.anchor, existingEntries:existing })
    .then(function(rows){
      btn.disabled=false; btn.textContent='Genera';
      planDraft = (rows||[]).map(function(r){
        return { title:r.title, time:r.time||'', timeEnd:r.timeEnd||'', category:r.category||'admin',
          isTodo:!!r.isTodo, kind:r.kind||'todo', onGoogle:!!r.onGoogle, reminders:(r.reminders||[]).slice() };
      });
      document.getElementById('plan-input-state').classList.add('hidden');
      document.getElementById('plan-draft-state').classList.remove('hidden');
      _renderPlanDraft();
    })
    .catch(function(e){
      btn.disabled=false; btn.textContent='Genera';
      alert('Non sono riuscito a interpretare la richiesta: '+e.message+'\nRiprova.');
    });
}

function _renderPlanDraft(){
  var list=document.getElementById('plan-draft-list');
  if(!planDraft.length){ list.innerHTML='<div class="plan-empty">Nessuna voce proposta.</div>'; return; }
  list.innerHTML = planDraft.map(function(row, idx){
    var catBtns = CATS.map(function(c){
      return '<button class="ed-cat tag-'+c.key+(c.key===row.category?' sel':'')+'" onclick="_planSetCat('+idx+',\''+c.key+'\')"><span>'+c.emoji+'</span></button>';
    }).join('');
    // solo l'orario di INIZIO è modificabile a mano: timeEnd resta nello stato
    // (serve per la durata dell'evento Calendar/reminder) ma non si mostra —
    // l'utente ragiona per "quando inizia", non per il blocco di tempo esatto.
    var timeFields = row.isTodo ? ''
      : '<input type="time" class="plan-time" value="'+row.time+'" onchange="_planSetTime('+idx+',this.value)">';
    return '<div class="plan-row" data-idx="'+idx+'">'
      + '<input type="text" class="plan-title" value="'+_esc(row.title)+'" onchange="_planSetTitle('+idx+',this.value)">'
      + '<div class="plan-row-flags">'
      + '<label class="plan-todo-flag"><input type="checkbox" '+(row.isTodo?'checked':'')+' onchange="_planSetTodo('+idx+',this.checked)"> todo</label>'
      + '<label class="plan-todo-flag"><input type="checkbox" '+(row.onGoogle?'checked':'')+' onchange="_planSetGoogle('+idx+',this.checked)"> 🗓️</label>'
      + '</div>'
      + timeFields
      + '<div class="plan-cats">'+catBtns+'</div>'
      + '<button class="plan-del" onclick="_planRemoveRow('+idx+')">🗑</button>'
      + '</div>';
  }).join('');
}
function _planSetTitle(idx, v){ planDraft[idx].title=v; }
// sposta l'orario di inizio mantenendo la durata originale (timeEnd non è
// mostrato in UI, ma va tenuto coerente: altrimenti spostare l'inizio a mano
// lascerebbe la fine ferma, con durate assurde o negative).
function _planSetTime(idx, v){
  var row=planDraft[idx];
  var oldStart=_hmToMin(row.time), oldEnd=_hmToMin(row.timeEnd);
  var newStart=_hmToMin(v);
  if(oldStart!=null && oldEnd!=null && newStart!=null){
    row.timeEnd=_minToHm(newStart + (oldEnd-oldStart));
  }
  row.time=v;
}
function _hmToMin(hm){ if(!hm) return null; var p=hm.split(':'); return (+p[0])*60+(+p[1]); }
function _minToHm(total){ total=((total%1440)+1440)%1440; var h=Math.floor(total/60), m=total%60; return ('0'+h).slice(-2)+':'+('0'+m).slice(-2); }
function _planSetTimeEnd(idx, v){ planDraft[idx].timeEnd=v; }
function _planSetCat(idx, cat){ planDraft[idx].category=cat; _renderPlanDraft(); }
function _planSetTodo(idx, isTodo){ planDraft[idx].isTodo=isTodo; if(isTodo){ planDraft[idx].time=''; planDraft[idx].timeEnd=''; } _renderPlanDraft(); }
// checkbox 🗓️ nella bozza: attiva/disattiva Google Calendar per quella voce.
// Reminder di default se attivato a mano qui (l'AI non ne ha proposti): 10 minuti prima.
function _planSetGoogle(idx, on){
  planDraft[idx].onGoogle=on;
  if(on && !planDraft[idx].reminders.length) planDraft[idx].reminders=[10];
  if(!on) planDraft[idx].reminders=[];
}
function _planRemoveRow(idx){ planDraft.splice(idx,1); _renderPlanDraft(); }

function confirmPlan(){
  if(!planDraft || !planDraft.length){ closePlanModal(); return; }
  var toCreate = planDraft.slice();
  closePlanModal();
  toCreate.forEach(function(row){
    if(!row.title.trim()) return;   // riga svuotata dall'utente: salta, non creare un impegno senza titolo
    var entry = { date: state.anchor, time: row.isTodo ? '' : row.time, title: row.title.trim(),
      category: row.category, onGoogle: row.onGoogle, reminders: row.onGoogle ? row.reminders.slice() : [],
      done: false, dateEnd: '', timeEnd: row.isTodo ? '' : row.timeEnd };
    var tmpId = 'tmp_'+Date.now()+Math.random().toString(36).slice(2,6);
    var localEntry = Object.assign({id:tmpId}, entry);
    _markPending(tmpId); _upsert(localEntry); render();
    apiPost({ action:'addEntry', entry: entry })
      .then(function(saved){ _removeLocal(tmpId); if(saved){ _upsert(saved); } render(); })
      .catch(function(e){ console.warn('plan addEntry bg:',e.message); });
  });
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

// Scrive html SOLO se diverso da quello già presente: evita il "flash" (reflow +
// reset scroll) quando si ridisegna con contenuto identico (es. dopo conferma server).
// Ritorna true se ha effettivamente riscritto (così il chiamante ricabla gli handler).
function _setHTML(el, html){ if(el.innerHTML===html){ return false; } el.innerHTML=html; return true; }

// ====== RENDER ======
function render(){
  document.getElementById('ag-title').innerHTML = _titleFor();
  var r=_rangeFor(state.view,state.anchor);
  _ensureRangeLoaded(r.from, r.to);   // scarica al volo se navighi fuori dalla finestra già in cache
  var rows=_entriesIn(r.from,r.to);
  if(state.view==='day') return renderDay(rows);
  if(state.view==='week') return renderWeek(rows);
  return renderMonth(rows);
}

function renderDay(rows){
  var body=document.getElementById('ag-body');
  body.ondblclick=function(ev){ if(!ev.target.closest('.ag-line')) openEditor(); };
  if(!rows.length){ _setHTML(body,'<div class="ag-empty">Niente per oggi.<br>Doppio tap per aggiungere.</div>'); return; }
  var html = rows.map(function(e){
    var pin=e.onGoogle?'<span class="ag-pin">📌</span>':'';
    var todo=_isTodoEntry(e);
    var lbl=_dayTimeLabel(e, state.anchor);
    var timeCol = todo ? '<span class="ag-time ag-todo" data-act="edit">todo</span>'
                       : '<span class="ag-time" data-act="edit">'+lbl+'</span>';
    var isBirthday = _catKey(e.category)==='birthday';
    var checkSpan = isBirthday
      ? '<span class="ag-check ag-check-cake">🎂</span>'
      : '<span class="ag-check'+(e.done?' done':'')+'" data-act="check"></span>';
    return '<div class="ag-line'+(e.done?' done':'')+(todo?' is-todo':'')+'" data-id="'+e.id+'">'
      +checkSpan
      +timeCol
      +'<span class="ag-txt" data-act="edit">'+_esc(e.title)+pin+'</span>'
      +_catTag(e.category)
      +'</div>';
  }).join('');
  if(!_setHTML(body, html)) return;   // identico: niente flash, handler già a posto
  Array.prototype.forEach.call(body.querySelectorAll('.ag-line'), function(line){
    var id=line.getAttribute('data-id');
    line.addEventListener('click', function(ev){
      var act=(ev.target.getAttribute('data-act'))||(ev.target.parentElement&&ev.target.parentElement.getAttribute('data-act'));
      if(act==='check') toggleDone(id); else if(act==='edit') openEditor(id);
    });
  });
}

function _byDay(rows){ var m={}; rows.forEach(function(e){ (m[e.date]=m[e.date]||[]).push(e); }); return m; }
// come _byDay ma espande gli eventi multi-giorno su tutti i giorni del range [from,to]
function _byDayExpanded(rows, from, to){
  var m={};
  rows.forEach(function(e){
    var s=e.date, en=e.dateEnd||e.date;
    var a=s<from?from:s, b=en>to?to:en;
    var p=a.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
    var bp=b.split('-'); var bd=new Date(+bp[0],+bp[1]-1,+bp[2]);
    while(d<=bd){ var k=_fmt(d); (m[k]=m[k]||[]).push(e); d.setDate(d.getDate()+1); }
  });
  return m;
}

function renderWeek(rows){
  var body=document.getElementById('ag-body'); body.ondblclick=null;
  var G=['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
  var today=_todayISO();
  // tutti e 7 i giorni della settimana, preimpostati (anche vuoti), uno sotto l'altro
  var r=_rangeFor('week',state.anchor); var s=r.from.split('-');
  var start=new Date(+s[0],+s[1]-1,+s[2]);
  var map=_byDayExpanded(rows, r.from, r.to);   // multi-giorno presenti in ogni giorno toccato
  var html='';
  for(var i=0;i<7;i++){
    var d=new Date(start); d.setDate(start.getDate()+i); var k=_fmt(d);
    var items=(map[k]||[]).map(function(e){
      return '<div class="wk-item tag-'+_catKey(e.category)+(e.done?' done':'')+'" data-id="'+e.id+'"><span class="wk-t">'+_dayTimeLabel(e,k)+'</span> '+_esc(e.title)+(e.onGoogle?' 📌':'')+'</div>';
    }).join('') || '<div class="wk-empty">—</div>';
    html+='<div class="wk-block'+(k===today?' today':'')+'"><div class="wk-day" onclick="goDay(\''+k+'\')">'+G[i]+' '+d.getDate()+'</div>'+items+'</div>';
  }
  if(!_setHTML(body, html)) return;   // identico: niente flash
  // tap su una voce esistente = modifica
  Array.prototype.forEach.call(body.querySelectorAll('.wk-item[data-id]'), function(it){
    it.addEventListener('click', function(){ openEditor(it.getAttribute('data-id')); });
  });
}

function renderMonth(rows){
  var body=document.getElementById('ag-body'); body.ondblclick=null;
  var p=state.anchor.split('-'); var year=+p[0], month=+p[1]-1;
  var startDow=(new Date(year,month,1).getDay()+6)%7, days=new Date(year,month+1,0).getDate();
  var today=_todayISO();

  // celle base: numero + eventi PUNTUALI onGoogle come righe brevi (i multi-giorno vanno nelle barre)
  var map=_byDay(rows);
  var cells='';
  for(var i=0;i<startDow;i++) cells+='<div class="mo-cell mo-empty"></div>';
  for(var dn=1;dn<=days;dn++){
    var key=year+'-'+('0'+(month+1)).slice(-2)+'-'+('0'+dn).slice(-2);
    var pts=(map[key]||[]).filter(function(e){ return !_isMulti(e) && e.onGoogle; });
    var evs=pts.slice(0,3).map(function(e){ return '<div class="mo-ev tag-'+_catKey(e.category)+'"><span>'+_esc(e.title)+'</span></div>'; }).join('');
    if(pts.length>3) evs+='<div class="mo-more">+'+(pts.length-3)+'</div>';
    cells+='<div class="mo-cell'+(key===today?' today':'')+'" onclick="goDay(\''+key+'\')"><div class="mo-num">'+dn+'</div>'+evs+'</div>';
  }

  // barre multi-giorno, per riga-settimana (spezzate a fine riga)
  var bars=_monthBars(rows.filter(_isMulti), year, month, startDow, days);

  _setHTML(body, '<div class="mo-wrap"><div class="mo-grid">'
    +'<div class="mo-h">L</div><div class="mo-h">M</div><div class="mo-h">M</div><div class="mo-h">G</div><div class="mo-h">V</div><div class="mo-h">S</div><div class="mo-h">D</div>'
    +cells+'</div>'+bars+'</div>');
}

// genera l'HTML delle barre multi-giorno posizionate in assoluto sopra la griglia
function _monthBars(multi, year, month, startDow, days){
  if(!multi.length) return '';
  function idxOf(dn){ return startDow + (dn-1); }      // indice cella 0-based (incl. celle vuote iniziali)
  function rowOf(ci){ return Math.floor(ci/7); }
  function colOf(ci){ return ci%7; }
  var firstISO=year+'-'+('0'+(month+1)).slice(-2)+'-01';
  var lastISO=year+'-'+('0'+(month+1)).slice(-2)+'-'+('0'+days).slice(-2);
  var html='';
  multi.forEach(function(e, ei){
    var s=e.date<firstISO?firstISO:e.date;             // clamp al mese visibile
    var en=(e.dateEnd||e.date)>lastISO?lastISO:(e.dateEnd||e.date);
    if(en<firstISO || s>lastISO) return;
    var sdn=+s.split('-')[2], edn=+en.split('-')[2];
    var dn=sdn;
    while(dn<=edn){
      var ci=idxOf(dn), row=rowOf(ci), col=colOf(ci);
      var spanEnd=dn;                                  // estendi fino a fine riga o fine evento
      while(spanEnd+1<=edn && colOf(idxOf(spanEnd+1))!==0){ spanEnd++; }
      var span=spanEnd-dn+1;
      var roundL=(dn===sdn)?' bar-l':'';               // estremo reale sinistro
      var roundR=(spanEnd===edn)?' bar-r':'';          // estremo reale destro
      html+='<div class="mo-bar tag-'+_catKey(e.category)+roundL+roundR+'" '
        +'style="--row:'+row+'; --col:'+col+'; --span:'+span+'; --lane:'+(ei%3)+'" '
        +'onclick="goDay(\''+s+'\')"><span>'+_esc(e.title)+'</span></div>';
      dn=spanEnd+1;
    }
  });
  return html;
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

// tap fuori dalla card (sul backdrop) mentre un campo ha il focus: chiude solo
// la tastiera, il popup resta aperto finché non premi Annulla/Salva/✕.
document.getElementById('editor').addEventListener('click', function(ev){
  if(ev.target.id==='editor' && document.activeElement) document.activeElement.blur();
});

// ====== EDITOR ======
// toggle a bottone-emoji (niente checkbox): stato letto/scritto via classe .active
function _toggleGet(id){ return document.getElementById(id).classList.contains('active'); }
function _toggleSet(id, on){ document.getElementById(id).classList.toggle('active', !!on); }
// L'editor è ora un modal centrato fisso: non serve più forzare il focus sul
// titolo dopo ogni tap sui bottoni icona (anzi, era quello a far ricomparire la
// tastiera in continuazione). No-op mantenuto per non toccare ogni chiamata.
function _keepKeyboard(){}

function _renderCats(){
  var isRec = document.getElementById('editor').classList.contains('is-recurring');
  var list = isRec ? REC_CATS : CATS;
  document.getElementById('ed-cats').innerHTML = list.map(function(c){
    return '<button class="ed-cat tag-'+c.key+(c.key===state.selCat?' sel':'')+'" onclick="selCat(\''+c.key+'\')">'
      + '<span>'+c.emoji+' '+c.label+'</span></button>';
  }).join('');
}
function selCat(c){ state.selCat=c; _renderCats(); _keepKeyboard(); }
function openEditor(id){
  state.editing=null; state.selCat='work'; state.fromPostitId=null; state.selReminders=[]; state.moveUnlocked=false;
  document.getElementById('ed-title').value='';
  document.getElementById('ed-time').value='';
  document.getElementById('ed-date').value=state.anchor;   // default: giorno corrente
  _toggleSet('ed-google', false);
  _toggleSet('ed-todo', false);
  _toggleSet('ed-extend', false);
  document.getElementById('ed-move').classList.remove('active');
  document.getElementById('ed-time-end').value='';
  document.getElementById('ed-date-end').value='';
  document.getElementById('ed-rec-time').value='';
  document.getElementById('ed-rec-time').disabled=false;
  document.getElementById('ed-rec-start').value=state.anchor;
  document.getElementById('ed-allday').checked=false;
  document.getElementById('ed-rec-freq').value='year';
  document.getElementById('ed-rec-interval').value=1;
  document.getElementById('editor').classList.remove('is-recurring');
  document.getElementById('ed-row-normal').classList.remove('hidden');
  document.getElementById('ed-row-recurring').classList.add('hidden');
  document.getElementById('ed-row-freq').classList.add('hidden');
  document.getElementById('ed-allday-row').classList.add('hidden');
  document.getElementById('ed-todo').classList.remove('hidden');
  document.getElementById('ed-extend').classList.remove('hidden');
  document.getElementById('ed-move').classList.remove('hidden');
  document.getElementById('ed-google').classList.remove('hidden');
  document.getElementById('ed-recurring').classList.remove('hidden');
  if(id){
    var e=cache.entries.find(function(x){ return x.id===id; });
    if(e){ state.editing=e; state.selCat=_catKey(e.category)||'work';
      state.selReminders=(e.reminders||[]).slice();
      document.getElementById('ed-title').value=e.title;
      document.getElementById('ed-time').value=e.time;
      document.getElementById('ed-date').value=e.date;
      _toggleSet('ed-google', e.onGoogle);
      _toggleSet('ed-todo', (!e.time && !(e.dateEnd&&e.dateEnd>e.date)));   // todo = senza orario e non multi-giorno
      var hasEnd=!!(e.dateEnd||e.timeEnd);
      _toggleSet('ed-extend', hasEnd);
      document.getElementById('ed-time-end').value=e.timeEnd||'';
      document.getElementById('ed-date-end').value=e.dateEnd||'';
      if(e.seriesId){
        document.getElementById('editor').classList.add('is-recurring');
        document.getElementById('ed-row-normal').classList.add('hidden');
        document.getElementById('ed-row-recurring').classList.remove('hidden');
        document.getElementById('ed-row-freq').classList.remove('hidden');
        document.getElementById('ed-allday-row').classList.remove('hidden');
        document.getElementById('ed-todo').classList.add('hidden');
        document.getElementById('ed-extend').classList.add('hidden');
        document.getElementById('ed-move').classList.add('hidden');
        document.getElementById('ed-google').classList.add('hidden');
        document.getElementById('ed-recurring').classList.add('hidden');
        document.getElementById('ed-rec-start').value=e.date;
        document.getElementById('ed-rec-time').value=e.time||'';
        document.getElementById('ed-allday').checked=!e.time;
        document.getElementById('ed-rec-time').disabled=!e.time;
        if(e.seriesRule){
          document.getElementById('ed-rec-freq').value=e.seriesRule.freq;
          document.getElementById('ed-rec-interval').value=e.seriesRule.interval;
        }
      }
    }
  }
  _applyTodoState();   // applica lo stato (abilita/disabilita orario+Google+Estendi)
  _applyExtendState(); // mostra/nasconde i campi fine in base allo stato
  _renderCats();
  document.getElementById('ed-delete').classList.toggle('hidden', !id);
  document.getElementById('ed-topostit').classList.toggle('hidden', !id);  // "Al post-it" solo in modifica
  document.getElementById('editor').classList.remove('hidden');
  // niente auto-focus sul titolo: in un modal centrato apre subito la tastiera
  // e la fa continuare a saltare fuori ad ogni interazione con gli altri campi.
}
function closeEditor(){ document.getElementById('editor').classList.add('hidden'); }

// applica lo stato ATTUALE di "Todo" ai campi correlati, senza invertirlo
// (usata sia dal click che da openEditor dopo aver precompilato lo stato).
function _applyTodoState(){
  var isTodo=_toggleGet('ed-todo');
  var timeEl=document.getElementById('ed-time'), gEl=document.getElementById('ed-google'), exEl=document.getElementById('ed-extend');
  if(isTodo){ _toggleSet('ed-extend', false); document.getElementById('ed-end-row').classList.add('hidden'); }   // todo annulla estendi
  timeEl.disabled=isTodo; if(isTodo) timeEl.value='';
  gEl.disabled=isTodo;    if(isTodo) _toggleSet('ed-google', false);
  exEl.disabled=isTodo;
  document.getElementById('ed-move').disabled=isTodo;
  _refreshDateLock();
  document.getElementById('editor').classList.toggle('is-todo', isTodo);
}
// "Todo": niente orario/Google/Estendi. click = inverte poi applica.
function onTodoToggle(){
  _toggleSet('ed-todo', !_toggleGet('ed-todo'));
  _applyTodoState();
  _keepKeyboard();
}
// il campo data resta sbloccato se "Estendi data" O "Sposta" (⏩) è attivo
function _refreshDateLock(){
  var unlocked = _toggleGet('ed-extend') || !!state.moveUnlocked;
  var dateEl=document.getElementById('ed-date');
  dateEl.disabled=!unlocked;
  dateEl.classList.toggle('ed-date-locked', !unlocked);
}
// applica lo stato ATTUALE di "Estendi" senza invertirlo (stesso motivo di _applyTodoState).
function _applyExtendState(){
  var ex=_toggleGet('ed-extend');
  document.getElementById('ed-end-row').classList.toggle('hidden', !ex);
  _refreshDateLock();
}
function onExtendToggle(){
  _toggleSet('ed-extend', !_toggleGet('ed-extend'));
  _applyExtendState();
  _keepKeyboard();
}
// "Sposta" (⏩): sblocca la SOLA data (niente multi-giorno/campi fine), per
// spostare un impegno singolo ad un altro giorno senza passare da "Estendi".
function onMoveToggle(){
  state.moveUnlocked=!state.moveUnlocked;
  document.getElementById('ed-move').classList.toggle('active', state.moveUnlocked);
  _refreshDateLock();
  _keepKeyboard();
}

// ====== MODALITÀ RICORRENTE (bottone 🔁 nell'editor) ======
// notifiche di default per gli impegni ricorrenti: sempre su Google Calendar,
// 1 giorno prima (1440min) + il giorno stesso (0min) — nessuna scelta manuale.
var REC_DEFAULT_REMINDERS = [0, 1440];
function onRecurringToggle(){
  var isRec = !document.getElementById('editor').classList.contains('is-recurring');
  document.getElementById('editor').classList.toggle('is-recurring', isRec);
  document.getElementById('ed-row-normal').classList.toggle('hidden', isRec);
  document.getElementById('ed-row-recurring').classList.toggle('hidden', !isRec);
  document.getElementById('ed-row-freq').classList.toggle('hidden', !isRec);
  document.getElementById('ed-allday-row').classList.toggle('hidden', !isRec);
  document.getElementById('ed-todo').classList.toggle('hidden', isRec);
  document.getElementById('ed-extend').classList.toggle('hidden', isRec);
  document.getElementById('ed-move').classList.toggle('hidden', isRec);
  document.getElementById('ed-google').classList.toggle('hidden', isRec);
  if(isRec){
    _toggleSet('ed-todo', false);
    _toggleSet('ed-extend', false);
    document.getElementById('ed-end-row').classList.add('hidden');
    document.getElementById('ed-rec-start').value=document.getElementById('ed-date').value || state.anchor;
    document.getElementById('ed-rec-time').value=document.getElementById('ed-time').value || '';
  }
  _renderCats();
  _keepKeyboard();
}
function onAllDayToggle(){
  var allDay=document.getElementById('ed-allday').checked;
  document.getElementById('ed-rec-time').disabled=allDay;
  if(allDay) document.getElementById('ed-rec-time').value='';
  _keepKeyboard();
}

// ====== NOTIFICHE (popup alla spunta di "Google Calendar") ======
function onGoogleToggle(){
  _toggleSet('ed-google', !_toggleGet('ed-google'));
  if(!_toggleGet('ed-google')){ _keepKeyboard(); return; }   // spento: niente popup
  var opts=document.querySelectorAll('#rem-modal .rem-opt input');
  Array.prototype.forEach.call(opts, function(cb){ cb.checked=(state.selReminders||[]).indexOf(+cb.value)>=0; });
  document.getElementById('rem-modal').classList.remove('hidden');
}
function remCancel(){
  // annulla il popup senza scegliere = niente notifiche custom (default di Google)
  state.selReminders=[];
  document.getElementById('rem-modal').classList.add('hidden');
  _keepKeyboard();
}
function remConfirm(){
  var opts=document.querySelectorAll('#rem-modal .rem-opt input:checked');
  state.selReminders=Array.prototype.map.call(opts, function(cb){ return +cb.value; });
  document.getElementById('rem-modal').classList.add('hidden');
  _keepKeyboard();
}

function saveEntry(){
  var title=document.getElementById('ed-title').value.trim();
  var isRec=document.getElementById('editor').classList.contains('is-recurring');
  if(!title){ alert('Scrivi cosa'); return; }

  if(isRec){
    var allDay=document.getElementById('ed-allday').checked;
    var recTime=allDay ? '' : document.getElementById('ed-rec-time').value;
    if(!allDay && !/^([01]\d|2[0-3]):[0-5]\d$/.test(recTime)){ alert('Orario obbligatorio (o spunta "Tutto il giorno")'); return; }
    var recStart=document.getElementById('ed-rec-start').value || state.anchor;
    var recFreq=document.getElementById('ed-rec-freq').value;
    var recInterval=Math.max(1, +document.getElementById('ed-rec-interval').value || 1);
    // Google Calendar è sempre attivo per i ricorrenti, con notifiche fisse di default
    var onGoogleRec=true;

    if(state.editing && state.editing.seriesId){
      // modifica di un'occorrenza esistente: chiede scope, poi propaga
      var entryMod={ id:state.editing.id, seriesId:state.editing.seriesId, date:recStart, time:recTime,
        title:title, category:state.selCat, onGoogle:onGoogleRec, allDay:allDay,
        reminders:REC_DEFAULT_REMINDERS.slice(),
        eventId:state.editing.eventId, done:state.editing.done||false, dateEnd:'', timeEnd:'' };
      closeEditor();
      _askScope('Modifica ricorrenza').then(function(scope){
        _markPending(entryMod.id);
        apiPost({ action:'updateEntry', entry:entryMod, scope:scope })
          .then(function(saved){ _clearPending(entryMod.id); if(saved){ var r=_seriesRangeFrom(recStart); syncRange(r.from, r.to); } })
          .catch(function(e){ console.warn('upd series bg:',e.message); });
      });
      return;
    }

    // nuova serie
    var count = recFreq==='year' ? 40 : 12;
    var newSeries={ date:recStart, time:recTime, title:title, category:state.selCat,
      onGoogle:onGoogleRec, reminders:REC_DEFAULT_REMINDERS.slice(),
      recurring:{ rule:{freq:recFreq, interval:recInterval}, allDay:allDay, count:count } };
    closeEditor();
    apiPost({ action:'addEntry', entry:newSeries })
      .then(function(saved){ (saved||[]).forEach(function(e){ _upsert(e); }); render(); })
      .catch(function(e){ console.warn('add series bg:',e.message); });
    return;
  }

  var isTodo=_toggleGet('ed-todo');
  var isExt=_toggleGet('ed-extend');
  var time=isTodo ? '' : document.getElementById('ed-time').value;
  var date=document.getElementById('ed-date').value || state.anchor;
  var timeEnd=(!isTodo && isExt) ? document.getElementById('ed-time-end').value : '';
  var dateEnd=(!isTodo && isExt) ? document.getElementById('ed-date-end').value : '';
  var isMulti=!!dateEnd && dateEnd>date;   // multi-giorno: l'ora inizio può mancare (= all-day)
  if(!isTodo && !isMulti && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)){ alert('Orario obbligatorio (o spunta "Todo")'); return; }
  if(time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)){ alert('Orario non valido'); return; }
  if(timeEnd && !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeEnd)){ alert('Ora fine non valida'); return; }
  // fine >= inizio (combinando data+ora; ora vuota = 00:00)
  if(dateEnd || timeEnd){
    var endD=dateEnd||date, endT=timeEnd||time||'00:00';
    if((endD+'T'+endT) < (date+'T'+(time||'00:00'))){ alert('La fine è prima dell\'inizio'); return; }
  }
  var onGoogle=isTodo ? false : _toggleGet('ed-google');
  var entry={ date:date, time:time, title:title, category:state.selCat,
    onGoogle:onGoogle, reminders:onGoogle ? (state.selReminders||[]).slice() : [],
    done:(state.editing&&state.editing.done)||false,
    dateEnd:dateEnd, timeEnd:timeEnd };
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

// popup "solo questa / questa e le successive": ritorna una Promise<'this'|'following'>
var _scopeResolveFn=null;
function _askScope(title){
  document.getElementById('scope-title').textContent=title;
  document.getElementById('scope-modal').classList.remove('hidden');
  return new Promise(function(resolve){ _scopeResolveFn=resolve; });
}
function _scopeResolve(scope){
  document.getElementById('scope-modal').classList.add('hidden');
  if(_scopeResolveFn){ _scopeResolveFn(scope); _scopeResolveFn=null; }
}
// range ampio a partire da una data, per ricaricare la cache dopo una propagazione
// (non sappiamo quante occorrenze future sono state toccate, quindi risincronizza tutto l'orizzonte serie)
function _seriesRangeFrom(fromDate){
  var p=fromDate.split('-'); var to=new Date(+p[0]+50,+p[1]-1,+p[2]);
  return { from:fromDate, to:_fmt(to) };
}

function deleteCurrent(){
  if(!state.editing) return;
  if(!confirm('Eliminare?')) return;
  var id=state.editing.id;
  var seriesId=state.editing.seriesId;
  if(seriesId){
    var seriesSeq=state.editing.seriesSeq;
    closeEditor();
    _askScope('Elimina ricorrenza').then(function(scope){
      var e=cache.entries.find(function(x){ return x.id===id; });
      if(scope==='following'){
        cache.entries = cache.entries.filter(function(x){ return !(x.seriesId===seriesId && x.seriesSeq>=seriesSeq); });
      } else if(e){ e._deleted=true; }
      _saveCache(); render();
      apiPost({ action:'deleteEntry', id:id, scope:scope }).catch(function(err){ console.warn('del series bg:',err.message); });
    });
    return;
  }
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
    _setHTML(list,'<div style="opacity:.45;font-style:italic;padding:10px 2px">'+hint+'</div>'); return;
  }
  var html = _piOrdered().map(function(it){
    return '<div class="pi-item'+(it.done?' done':'')+'" data-id="'+it.id+'">'
      +'<span class="pi-check" data-act="toggle"></span>'
      +'<span class="pi-text" data-act="tap">'+_esc(it.text)+'</span>'
      +'<span class="pi-del">🗑</span></div>';
  }).join('');
  if(!_setHTML(list, html)) return;   // identico: niente flash
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

// Il post-it BTN (note-btn): TAP singolo apre il main, DOPPIO TAP crea una lista al volo.
// Niente swipe (le gesture laterali del telefono lo intercetterebbero).
(function(){
  var btn=document.getElementById('note-btn');
  if(!btn) return;
  btn.removeAttribute('onclick');   // gestiamo noi tap vs doppio-tap
  var lastTap=0, timer=null;
  function single(){ openPostit(); }
  function double(){ if(!_createTemp()){ btn.classList.add('shake'); setTimeout(function(){ btn.classList.remove('shake'); },350); } }
  btn.addEventListener('click', function(){
    var now=Date.now();
    if(now-lastTap < 320){ clearTimeout(timer); timer=null; lastTap=0; double(); }
    else { lastTap=now; clearTimeout(timer); timer=setTimeout(function(){ timer=null; single(); }, 320); }
  });
})();

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
// fasce: devono combaciare col backend. Due set (feriale/weekend); il giorno decide.
var TK_SLOTS_WEEK    = ['06:00-08:30','08:30-15:00','15:00-16:00','16:00-17:00','17:00-19:00','19:00-21:00','21:00-24:00'];
var TK_SLOTS_WEEKEND = ['06:00-09:00','09:00-13:00','13:00-15:00','15:00-17:00','17:00-19:00','19:00-21:00','21:00-24:00'];
function _isWeekendISO(date){ var p=date.split('-'); var w=new Date(+p[0],+p[1]-1,+p[2]).getDay(); return w===0||w===6; }
function _slotsFor(date){ return _isWeekendISO(date) ? TK_SLOTS_WEEKEND : TK_SLOTS_WEEK; }
var tkState = { date:null, bySlot:{}, slots:[] };

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

// Il bookmark è CONTESTUALE: in vista mese apre il riepilogo mensile,
// in giorno/settimana apre i voti del giorno.
function openTracking(){
  if(state.view==='month') return openMonthStats();
  tkState.date = state.anchor;
  tkState.slots = _slotsFor(tkState.date);             // fasce del giorno (feriale/weekend)
  tkState.bySlot = _trkCacheGet(tkState.date) || {};   // subito dalla cache (niente vuoto)
  document.getElementById('tracking').classList.remove('hidden');
  renderTracking();
  apiGet({ action:'getTracking', date:tkState.date }).then(function(d){
    var fresh={}; (d&&d.entries||[]).forEach(function(e){ fresh[e.slot]=e; });
    if(d&&d.slots&&d.slots.length) tkState.slots=d.slots;   // fasce autorevoli dal server
    // ridisegna solo se cambiato (evita il refresh/flicker inutile)
    if(JSON.stringify(fresh)!==JSON.stringify(tkState.bySlot)){
      tkState.bySlot=fresh; _trkCacheSet(tkState.date, fresh);
    }
    renderTracking();
  }).catch(function(e){ console.warn('tracking get bg:',e.message); });
}
function closeTracking(){ document.getElementById('tracking').classList.add('hidden'); }

function renderTracking(){
  var p=tkState.date.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
  var oggi = tkState.date===_todayISO();
  _setHTML(document.getElementById('tk-title'), '<span>'+d.getDate()+' '+MESI[d.getMonth()].toUpperCase()+'</span><span class="sub">'+(oggi?'i voti di oggi':'voti del giorno')+'</span>');
  var html='';
  (tkState.slots&&tkState.slots.length ? tkState.slots : _slotsFor(tkState.date)).forEach(function(slot){
    var rec=tkState.bySlot[slot];
    var past=_isPast(slot, tkState.date);
    if(rec && (rec.pleasure!=null || rec.utility!=null || rec.mood!=null || rec.activity)){
      var votes='';
      if(rec.pleasure!=null) votes+='<span class="tk-v p">'+rec.pleasure+'</span>';
      if(rec.utility!=null)  votes+='<span class="tk-v u">'+rec.utility+'</span>';
      if(rec.mood!=null)     votes+='<span class="tk-v m '+moodClass(rec.mood)+'">'+rec.mood+' '+moodFace(rec.mood)+'</span>';
      html+='<div class="tk-slot" onclick="openRate(\''+slot+'\')"><div class="tk-time">'+slot.replace('-',' – ')+'</div><div class="tk-act">'+_esc(rec.activity||'(senza nota)')+'</div><div class="tk-votes">'+votes+'</div></div>';
    } else if(past){
      html+='<div class="tk-slot" onclick="openRate(\''+slot+'\')"><div class="tk-time">'+slot.replace('-',' – ')+'</div><div class="tk-act empty">da votare…</div><div class="tk-votes"><span class="tk-add">+</span></div></div>';
    } else {
      html+='<div class="tk-slot future"><div class="tk-time">'+slot.replace('-',' – ')+'</div><div class="tk-act empty">— non ancora</div></div>';
    }
  });
  _setHTML(document.getElementById('tk-slots'), html);   // riscrive solo se cambiato (niente flash)
  _setHTML(document.getElementById('tk-recap'), _recapHTML());
}

// recap in fondo: medie del GIORNO visualizzato (solo fasce votate)
function _recapHTML(){
  var recs=Object.keys(tkState.bySlot).map(function(k){ return tkState.bySlot[k]; });
  function avg(field){
    var v=recs.map(function(r){ return r&&r[field]; }).filter(function(x){ return x!=null && x!==''; });
    if(!v.length) return null;
    return v.reduce(function(a,b){ return a+(+b); },0)/v.length;
  }
  var p=avg('pleasure'), u=avg('utility'), m=avg('mood');
  if(p==null && u==null && m==null) return '';
  function one(lab, val, extra){
    if(val==null) return '<div class="tk-rc"><div class="tk-rc-lab">'+lab+'</div><div class="tk-rc-val">—</div></div>';
    return '<div class="tk-rc"><div class="tk-rc-lab">'+lab+'</div><div class="tk-rc-val">'+val.toFixed(1)+(extra||'')+'</div></div>';
  }
  var mFace = m==null ? '' : ' <span class="tk-rc-face '+moodClass(Math.round(m))+'">'+moodFace(Math.round(m))+'</span>';
  return '<div class="tk-recap-title">media del giorno</div><div class="tk-recap-row">'
    + one('piacevolezza', p) + one('utilità', u) + one('mood', m, mFace) + '</div>';
}

// ---- effetto bookmark: pulsa se OGGI ci sono fasce passate non votate ----
function _slotVoted(rec){ return rec && (rec.pleasure!=null || rec.utility!=null || rec.mood!=null || rec.activity); }
function refreshBookmarkBadge(){
  var bm=document.getElementById('bookmark'); if(!bm) return;
  var bySlot = _trkCacheGet(_todayISO()) || {};
  var arretrate = _slotsFor(_todayISO()).filter(function(s){ return _isPast(s, _todayISO()) && !_slotVoted(bySlot[s]); }).length;
  bm.classList.toggle('pending', arretrate>0);
  bm.setAttribute('data-count', arretrate>0 ? arretrate : '');
}

// ====== RIEPILOGO MENSILE (grafico 3 linee + medie) ======
// Si apre dal bookmark quando sei in vista MESE. Sola lettura.
var msState = { from:null, to:null, data:null };

function openMonthStats(){
  var r=_rangeFor('month', state.anchor);
  msState.from=r.from; msState.to=r.to; msState.data=null;
  var p=state.anchor.split('-'); var d=new Date(+p[0],+p[1]-1,+p[2]);
  _setHTML(document.getElementById('ms-title'),
    '<span>'+MESI[d.getMonth()].toUpperCase()+'</span><span class="sub">'+d.getFullYear()+'</span>');
  document.getElementById('monthstats').classList.remove('hidden');
  _setHTML(document.getElementById('ms-body'), '<div class="ms-loading">carico…</div>');
  apiGet({ action:'getTrackingRange', from:r.from, to:r.to })
    .then(function(d2){ msState.data=d2; renderMonthStats(); })
    .catch(function(e){
      _setHTML(document.getElementById('ms-body'), '<div class="ms-loading">niente dati (rete?)</div>');
      console.warn('range bg:',e.message);
    });
}
function closeMonthStats(){ document.getElementById('monthstats').classList.add('hidden'); }

// Voti storici salvati con la vecchia scala 0-10: uno 0 sfonderebbe il grafico (scala 1-10)
// finendo sopra le etichette. Lo riportiamo a 1 (entrambi significavano "il minimo").
function _clamp10(v){ if(v==null) return null; return Math.max(1, Math.min(10, v)); }

var MS_FIELDS = [
  { k:'pleasure', cls:'p', lab:'piacevolezza' },
  { k:'utility',  cls:'u', lab:'utilità' },
  { k:'mood',     cls:'m', lab:'mood' }
];

function renderMonthStats(){
  var d=msState.data;
  if(!d || !d.days || !d.days.length){
    _setHTML(document.getElementById('ms-body'), '<div class="ms-loading">nessun voto questo mese</div>');
    return;
  }
  var daysInMonth=+msState.to.split('-')[2];
  var byNum={};
  d.days.forEach(function(x){ byNum[+x.date.split('-')[2]]=x; });

  // ---- grafico ORIZZONTALE: giorni sull'asse X (sotto), voti 1-10 sull'asse Y
  // con le etichette dei valori a DESTRA.
  var COL=11;                                   // larghezza per giorno
  var PL=6, PR=20, PT=10, PB=18;                // PR = spazio numeri voto (a destra)
  var W=PL+PR+daysInMonth*COL, H=190;
  var ih=H-PT-PB;
  function X(n){ return PL + (n-0.5)*COL; }     // giorno n al centro della sua colonna
  function Y(v){ return PT + (10-v)/9*ih; }     // voto 1..10 → basso..alto

  // griglia orizzontale su OGNI valore 1..10 + numeri A DESTRA
  var grid='', ylab='';
  for(var v=1; v<=10; v++){
    var strong=(v===1||v===5||v===10);
    grid+='<line class="ms-grid'+(strong?' strong':'')+'" x1="'+PL+'" y1="'+Y(v).toFixed(1)+'" x2="'+(W-PR).toFixed(1)+'" y2="'+Y(v).toFixed(1)+'"/>';
    ylab+='<text class="ms-ylab" x="'+(W-PR+4).toFixed(1)+'" y="'+(Y(v)+3).toFixed(1)+'">'+v+'</text>';
  }
  // etichette giorni: TUTTI i numeri sotto (alternati su 2 righe per non sovrapporsi)
  var xlab='';
  for(var n=1;n<=daysInMonth;n++){
    var y = (n%2===1) ? (H-9) : (H-1);          // dispari sopra, pari sotto
    xlab+='<text class="ms-xlab" x="'+X(n).toFixed(1)+'" y="'+y+'">'+n+'</text>';
  }

  function path(field){
    var started=false, out='';
    for(var n=1;n<=daysInMonth;n++){
      var rec=byNum[n];
      var v=rec ? _clamp10(rec[field]) : null;
      if(v==null){ started=false; continue; }    // giorno non votato: spezza la linea
      out += (started?' L':' M') + X(n).toFixed(1) + ' ' + Y(v).toFixed(1);
      started=true;
    }
    return out.trim();
  }
  // i pallini portano i dati per la bolla (tap/hover)
  function dots(f){
    var s='';
    for(var n=1;n<=daysInMonth;n++){
      var rec=byNum[n]; if(!rec) continue;
      var v=_clamp10(rec[f.k]); if(v==null) continue;
      s+='<circle class="ms-dot '+f.cls+'" cx="'+X(n).toFixed(1)+'" cy="'+Y(v).toFixed(1)+'" r="3"'
       + ' data-lab="'+f.lab+'" data-val="'+(Math.round(rec[f.k]*10)/10)+'" data-day="'+n+'"/>';
    }
    return s;
  }
  var lines='', points='';
  MS_FIELDS.forEach(function(f){
    lines += '<path class="ms-line '+f.cls+'" d="'+path(f.k)+'"/>';
    points += dots(f);
  });

  var svg='<svg class="ms-chart" id="ms-svg" viewBox="0 0 '+W+' '+H+'">'
    + grid + xlab + ylab + lines + points + '</svg>';

  var legend='<div class="ms-legend">'
    + MS_FIELDS.map(function(f){ return '<span class="ms-lg '+f.cls+'">'+f.lab+'</span>'; }).join('')
    + '</div>';

  // ---- medie del mese ----
  function box(lab, val, extra){
    var t = val==null ? '—' : val.toFixed(1);
    return '<div class="tk-rc"><div class="tk-rc-lab">'+lab+'</div><div class="tk-rc-val">'+t+(extra||'')+'</div></div>';
  }
  var a=d.avg||{};
  var mFace = a.mood==null ? '' : ' <span class="tk-rc-face '+moodClass(Math.round(_clamp10(a.mood)))+'">'+moodFace(Math.round(_clamp10(a.mood)))+'</span>';
  var avgHTML='<div class="tk-recap-title">media del mese ('+(a.n||0)+' giorni votati)</div>'
    + '<div class="tk-recap-row">'+box('piacevolezza',a.pleasure)+box('utilità',a.utility)+box('mood',a.mood,mFace)+'</div>';

  _setHTML(document.getElementById('ms-body'),
    legend + '<div class="ms-chart-wrap">'+svg+'<div id="ms-tip" class="ms-tip hidden"></div></div>'
    + '<div class="ms-avg">'+avgHTML+'</div>');
  _wireMsDots();
}

// bolla con "cos'è + voto" al tap/hover su un pallino
function _wireMsDots(){
  var wrap=document.querySelector('.ms-chart-wrap'); if(!wrap) return;
  var tip=document.getElementById('ms-tip');
  var svg=document.getElementById('ms-svg');
  function show(c){
    tip.textContent = c.getAttribute('data-lab')+' '+c.getAttribute('data-val')+' · giorno '+c.getAttribute('data-day');
    // posizione: converte le coordinate SVG in pixel del contenitore
    var r=svg.getBoundingClientRect(), wr=wrap.getBoundingClientRect();
    var vb=svg.viewBox.baseVal;
    var px=(+c.getAttribute('cx'))/vb.width*r.width + (r.left-wr.left);
    var py=(+c.getAttribute('cy'))/vb.height*r.height + (r.top-wr.top);
    tip.classList.remove('hidden');
    tip.style.left=Math.max(4, Math.min(px, wr.width-tip.offsetWidth-4))+'px';
    tip.style.top=Math.max(0, py-tip.offsetHeight-8)+'px';
  }
  function hide(){ tip.classList.add('hidden'); }
  Array.prototype.forEach.call(svg.querySelectorAll('.ms-dot'), function(c){
    c.addEventListener('mouseenter', function(){ show(c); });
    c.addEventListener('mouseleave', hide);
    c.addEventListener('click', function(ev){ ev.stopPropagation(); show(c); });
  });
  svg.addEventListener('click', hide);   // tap altrove = chiudi la bolla
}

// ====== MODAL VOTI (unico) ======
var rateState = { slot:null, rec:null, acIdx:-1 };
// storico attività dal DB (per l'autocomplete), caricato una volta e riusato
var actHistory = [];

// minuti dall'inizio giornata per una 'HH:mm'
function _hm(t){ var p=String(t).split(':'); return (+p[0])*60+(+p[1]); }
// voci d'agenda del giorno che cadono nella fascia: eventi con orario dentro [start,end)
// + i todo del giorno (senza orario), utili come promemoria di cosa c'era da fare.
function _entriesInSlot(date, slot){
  var s=_hm(slot.split('-')[0]), e=_hm(slot.split('-')[1]);
  return cache.entries.filter(function(en){
    if(en._deleted || en.date!==date) return false;
    if(!en.time){ return true; }                 // todo del giorno: sempre suggerito
    var m=_hm(en.time); return m>=s && m<e;       // evento con orario dentro la fascia
  }).map(function(en){ return en.title; });
}
// scarica lo storico attività dal foglio Tracking (non da localStorage: la cache si pulisce)
function loadActivities(){
  apiGet({ action:'getActivities' })
    .then(function(list){ if(list&&list.length) actHistory=list; })
    .catch(function(e){ console.warn('getActivities bg:',e.message); });
}

// ---- autocomplete "cos'ho fatto" ----
// L'input è UNO solo; i suggerimenti completano l'ULTIMO pezzo dopo l'ultimo ' + '.
function _acParts(v){ return String(v).split('+'); }
function _acCurrentTerm(){
  var v=document.getElementById('rate-act').value;
  var parts=_acParts(v);
  return parts[parts.length-1].trim();
}
// candidati: eventi della fascia + storico DB, senza duplicati e senza quelli già scritti
function _acCandidates(term){
  var already=_acParts(document.getElementById('rate-act').value)
    .slice(0,-1).map(function(s){ return s.trim().toLowerCase(); });
  var pool=_entriesInSlot(tkState.date, rateState.slot).concat(actHistory);
  var seen={}, out=[];
  pool.forEach(function(t){
    var k=String(t).trim(); if(!k) return;
    var lk=k.toLowerCase();
    if(seen[lk] || already.indexOf(lk)>=0) return;
    if(term && lk.indexOf(term.toLowerCase())<0) return;   // filtra per quello che stai scrivendo
    seen[lk]=true; out.push(k);
  });
  return out.slice(0,6);
}
function _renderAC(){
  var box=document.getElementById('rate-ac');
  var term=_acCurrentTerm();
  rateState.acIdx=-1;
  // la tendina compare SOLO mentre stai digitando (almeno 1 lettera), non a campo vuoto
  if(!term){ box.classList.add('hidden'); box.innerHTML=''; return; }
  var list=_acCandidates(term);
  if(!list.length){ box.classList.add('hidden'); box.innerHTML=''; return; }
  box.innerHTML=list.map(function(t,i){
    return '<button class="rate-ac-item" data-i="'+i+'" data-t="'+_esc(t)+'">'+_esc(t)+'</button>';
  }).join('');
  Array.prototype.forEach.call(box.querySelectorAll('.rate-ac-item'), function(b){
    b.addEventListener('mousedown', function(ev){ ev.preventDefault(); _acPick(b.getAttribute('data-t')); });
  });
  box.classList.remove('hidden');
}
// completa l'ultimo pezzo scritto, SENZA aggiungere il '+' (che darebbe fastidio quando
// l'attività è una sola). Per aggiungerne un'altra basta digitare ' + ' o premere il tasto '+'.
function _acPick(text){
  var el=document.getElementById('rate-act');
  var parts=_acParts(el.value);
  parts[parts.length-1]=' '+text;
  el.value=parts.join('+').replace(/^\s+/,'');
  el.focus();
  var box=document.getElementById('rate-ac');
  box.classList.add('hidden'); box.innerHTML=''; rateState.acIdx=-1;   // scelto: chiudi
}

// mood 1-10 a fasce (scala presa da Ale): 1-2 pessimo … 9-10 stellare
function moodFace(v){ return v<=2?'😖':v<=4?'🙁':v<=6?'😐':v<=8?'🙂':'😄'; }
function moodClass(v){ return v<=2?'m1':v<=4?'m3':v<=6?'m5':v<=8?'m7':'m9'; }

function openRate(slot){
  rateState.slot=slot;
  var ex = tkState.bySlot[slot];
  rateState.rec = ex ? { date:tkState.date, slot:slot, id:ex.id, activity:ex.activity||'',
                         pleasure:ex.pleasure, utility:ex.utility, mood:ex.mood }
                     : { date:tkState.date, slot:slot, activity:'', pleasure:null, utility:null, mood:null };
  document.getElementById('rate-slot').textContent = slot.replace('-',' – ');
  document.getElementById('rate-act').value = rateState.rec.activity||'';
  document.getElementById('rate-pleasure').value = rateState.rec.pleasure||5;
  document.getElementById('rate-utility').value = rateState.rec.utility||5;
  document.getElementById('rate-mood').value = rateState.rec.mood||5;
  _rateSyncLabels();
  document.getElementById('rate-ac').classList.add('hidden');
  document.getElementById('rate').classList.remove('hidden');
  setTimeout(function(){ document.getElementById('rate-act').focus(); }, 80);
}
function closeRate(){
  document.getElementById('rate').classList.add('hidden');
  document.getElementById('rate-ac').classList.add('hidden');
}
// aggiorna numeri e faccina accanto alle etichette
function _rateSyncLabels(){
  var p=+document.getElementById('rate-pleasure').value;
  var u=+document.getElementById('rate-utility').value;
  var m=+document.getElementById('rate-mood').value;
  document.getElementById('rate-pleasure-val').textContent=p;
  document.getElementById('rate-utility-val').textContent=u;
  document.getElementById('rate-mood-val').textContent=m;
  var face=document.getElementById('rate-mood-face');
  face.textContent=moodFace(m);
  face.className='rate-face '+moodClass(m);
  document.getElementById('rate-mood').className='rate-slider mood '+moodClass(m);
}
// salva: pulisce il testo dai ' + ' pendenti, scrive cache+UI subito, poi manda al backend
function rateSave(){
  var raw=document.getElementById('rate-act').value;
  var act=raw.split('+').map(function(s){ return s.trim(); }).filter(function(s){ return s; }).join(' + ');
  var rec=rateState.rec;
  rec.activity=act;
  rec.pleasure=+document.getElementById('rate-pleasure').value;
  rec.utility=+document.getElementById('rate-utility').value;
  rec.mood=+document.getElementById('rate-mood').value;
  tkState.bySlot[rec.slot]=rec; _trkCacheSet(tkState.date, tkState.bySlot);   // UI + cache subito
  closeRate();
  renderTracking(); refreshBookmarkBadge();
  apiPost({ action:'setTracking', rec:rec })
    .then(function(saved){
      if(saved){ tkState.bySlot[saved.slot]=saved; _trkCacheSet(tkState.date, tkState.bySlot); }
      loadActivities();   // la nuova attività entra nello storico dei suggerimenti
    })
    .catch(function(e){ console.warn('tracking save bg:',e.message); });
}
// wiring modal voti
document.getElementById('rate-act').addEventListener('input', _renderAC);
document.getElementById('rate-act').addEventListener('keydown', function(e){
  var box=document.getElementById('rate-ac');
  var items=box.querySelectorAll('.rate-ac-item');
  if(e.key==='ArrowDown' && items.length){ e.preventDefault();
    rateState.acIdx=Math.min(rateState.acIdx+1, items.length-1); _acHighlight(items); }
  else if(e.key==='ArrowUp' && items.length){ e.preventDefault();
    rateState.acIdx=Math.max(rateState.acIdx-1, 0); _acHighlight(items); }
  else if(e.key==='Enter'){ e.preventDefault();
    if(rateState.acIdx>=0 && items[rateState.acIdx]) _acPick(items[rateState.acIdx].getAttribute('data-t'));
    else box.classList.add('hidden');
  }
});
function _acHighlight(items){
  Array.prototype.forEach.call(items, function(it,i){ it.classList.toggle('on', i===rateState.acIdx); });
}
document.getElementById('rate-pleasure').addEventListener('input', _rateSyncLabels);
document.getElementById('rate-utility').addEventListener('input', _rateSyncLabels);
document.getElementById('rate-mood').addEventListener('input', _rateSyncLabels);
// tap sullo sfondo = chiudi senza salvare (c'è il bottone Salva)
document.getElementById('rate').addEventListener('click', function(e){
  if(e.target===this) closeRate();
});

// ====== service worker (PWA) ======
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(e){ console.warn('SW:', e); }); });
}

boot();
