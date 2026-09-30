// The admin page. One HTML string, no build. Dark monospace, live over SSE.
export function dashboardHtml({ base, tz }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Analytics</title>
<style>
:root{--bg:#1c1a17;--fg:#e8e2d8;--dim:#9a9184;--line:#3a352f;--card:#26231f;--acc:#e6a54a;--ok:#8fc98a;--bad:#e07a6a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:32px 20px 80px}
main{max-width:920px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}h2{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin:40px 0 12px;font-weight:500}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.nav{color:var(--dim);margin-bottom:20px}.nav input[type=date]{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit}
.nav select,.nav button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font:inherit}
.tiles{display:flex;flex-wrap:wrap;gap:8px}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 18px;min-width:130px}
.tile b{display:block;font-size:24px;color:var(--acc);font-weight:600}.tile span{color:var(--dim);font-size:12px}
.tile.live b{color:var(--ok)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:right;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--dim);font-weight:500;font-size:11px}
th:first-child,td:first-child{text-align:left}td.z{color:var(--dim)}.wrap{overflow-x:auto;max-width:100%}
th{padding:0}th button{background:none;border:0;color:inherit;font:inherit;font-size:11px;letter-spacing:0;padding:10px 8px;min-height:44px;width:100%;text-align:inherit;cursor:pointer}th button:hover{color:var(--acc)}
button:focus-visible,summary:focus-visible,a:focus-visible{outline:2px solid var(--acc);outline-offset:2px}th[aria-sort]{color:var(--fg)}
details{min-width:0;margin-top:28px}summary{cursor:pointer;min-height:44px;padding:10px 0;color:var(--dim)}summary h2{display:inline;margin:0}details[open]>summary{color:var(--fg)}
.best{color:var(--acc);font-weight:600}.muted{color:var(--dim);font-size:12px}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:24px}.cols>div{min-width:0}
#ticker{font-size:12px;color:var(--dim);max-height:320px;overflow:auto}#ticker div{padding:2px 0;border-bottom:1px solid var(--line)}#ticker .n{color:var(--fg)}#ticker .new{color:var(--ok)}
.bump{animation:bump .5s}@keyframes bump{from{color:var(--ok)}to{color:inherit}}
@media(prefers-reduced-motion:reduce){.bump{animation:none}}
.err{color:var(--bad)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--bad);margin-right:6px}.dot.on{background:var(--ok)}
</style></head><body><main>
<h1>Analytics</h1>
<div class="nav"><span class="dot" id="dot"></span><span id="sitewrap">site <select id="site"></select></span> · <select id="days"><option value="1">today</option><option value="2">yesterday and today</option><option value="7">last 7 days</option><option value="14">last 14 days</option><option value="30" selected>last 30 days</option><option value="90">last 90 days</option><option value="">custom</option></select> <input type="date" id="from"> to <input type="date" id="to"> · times in ${esc(tz)} · <a id="csv" href="#">csv</a> · <a id="jsonl" href="#">jsonl</a></div>
<p class="muted" id="table-help">Select a section to expand it. Select any table heading to sort; select it again to reverse.</p>
<div id="app"><p class="muted">loading…</p></div>
<details><summary><h2>Live</h2></summary>
<div id="ticker"><div class="muted">waiting for events…</div></div>
</details>
<details id="definitions"><summary><h2>Measurement definitions</h2></summary>
<p class="muted">Qualified play uses all retained measurement data for the selected site; the date controls filter the event tables. Only games with measurement reports appear. A missing game is not a measured zero.</p>
<p class="muted">An engaged visit needs 30 seconds of observed active play and two accepted input buckets spanning at least five seconds. Active play requires a visible, focused, playable game and input within the last 60 seconds. Visits join across gaps under 30 minutes and settle after 32 quiet minutes. Short genuine arrivals stay in the settled-visit denominator; pending visits are not failures.</p>
<p class="muted">First-visit playtime starts with each persistent browser’s first qualified visit. Next-day returns count input in a later same-game visit 24–48 hours after first qualified play; day-7 returns use 168–192 hours. A short return can count without qualifying again. The full window plus two minutes of delivery grace must pass before a browser enters a denominator. Seven-day playtime sums observed intervals in the first 168 hours; overlapping tabs count once.</p>
<p class="muted">— means no eligible sample, including an incomplete window; 0 is an observed zero. Samples count browsers. Temporary identities cannot enter retention cohorts. An unconfirmed end means a stream lacks a closing report. Reported time is a lower bound. Browser IDs are origin-local random IDs in localStorage, not verified people or cross-device identities.</p>
</details>
<p class="muted" style="margin-top:40px">To hide your own visits, open any page of the site with <code>?tally=ignore</code> once on each device. <code>?tally=track</code> turns it back on.</p>
</main>
<script>
var BASE=${JSON.stringify(base)}, S={}, site=new URLSearchParams(location.search).get('site')||'', es=null, sites=[], sorts=Object.create(null), sections=Object.create(null);
var $=function(s){return document.querySelector(s)};
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function n(v){return v==null?'—':Number(v).toLocaleString()}
function fmtT(ms){var d=new Date(ms);return d.toLocaleTimeString([],{hour12:false})}
function secs(s){if(s==null)return '—';s=Math.round(s);return s<60?s+'s':Math.floor(s/60)+'m '+(s%60)+'s'}
function win(){return 'from='+$('#from').value+'&to='+$('#to').value}
async function loadSites(){sites=await (await fetch(BASE+'/sites.json?'+win())).json();var sel=$('#site');sel.innerHTML=sites.map(function(s){return '<option value="'+esc(s.site)+'">'+esc(s.site)+' ('+n(s.visitors)+')</option>'}).join('');if(!site&&sites[0])site=sites[0].site;if(site&&!sites.some(function(s){return s.site===site}))sel.insertAdjacentHTML('afterbegin','<option value="'+esc(site)+'">'+esc(site)+' (0)</option>');sel.value=site;$('#sitewrap').style.display=sites.length>1?'':'none'}
async function load(){await loadSites();var rs=await Promise.all([fetch(BASE+'/stats.json?site='+encodeURIComponent(site)+'&'+win()).then(function(r){return r.json()}),fetch(BASE+'/measurement.json?site='+encodeURIComponent(site)).then(function(r){if(!r.ok)throw Error('measurement');return r.json()}).catch(function(){return null})]);S=rs[0];M=rs[1];history.replaceState(null,'','?site='+encodeURIComponent(site)+'&'+win());$('#csv').href=BASE+'/export.csv?site='+encodeURIComponent(site);$('#jsonl').href=BASE+'/export.jsonl?site='+encodeURIComponent(site);render();connect()}
var M=null;
function pct(p,g){return p==null?'<span class="z">—</span>':Math.round(p*100)+'% ('+g[0]+' of '+g[1]+')'}
function mins(v){return v==null?'<span class="z">—</span>':(Math.round(v*10)/10)+' min'}
var MCOLS=[
 {k:'game',label:'Game',get:function(g){return g.gameId},html:function(g){return '<a href="?site='+encodeURIComponent(g.site)+'">'+esc(g.gameId)+'</a>'}},
 {k:'browsers',label:'Browsers',get:function(g){return g.measuredBrowsers},html:function(g){return n(g.measuredBrowsers)}},
 {k:'engaged',label:'Engaged browsers',get:function(g){return g.engagedBrowsers},html:function(g){return n(g.engagedBrowsers)}},
 {k:'rate',label:'Engaged visits (%)',get:function(g){return g.engagementRate},html:function(g){return pct(g.engagementRate,[g.qualifiedVisits,g.eligibleVisits])}},
 {k:'avg',label:'Avg playtime · first visit',get:function(g){return g.initialMeanMinutes},html:function(g){return mins(g.initialMeanMinutes)}},
 {k:'med',label:'Median playtime · first visit',get:function(g){return g.initialMedianMinutes},html:function(g){return mins(g.initialMedianMinutes)}},
 {k:'sample',label:'Sample (browsers)',get:function(g){return g.initialSample},html:function(g){return n(g.initialSample)}}
];
var RCOLS=[MCOLS[0],
 {k:'d1',label:'Next-day returns (%)',get:function(g){return g.d1},html:function(g){return pct(g.d1,[g.d1Returns,g.d1Denominator])}},
 {k:'d7',label:'Day-7 returns (%)',get:function(g){return g.d7},html:function(g){return pct(g.d7,[g.d7Returns,g.d7Denominator])}},
 {k:'avg7',label:'Avg playtime · first 7 days',get:function(g){return g.sevenDayMeanMinutes},html:function(g){return mins(g.sevenDayMeanMinutes)}},
 {k:'med7',label:'Median playtime · first 7 days',get:function(g){return g.sevenDayMedianMinutes},html:function(g){return mins(g.sevenDayMedianMinutes)}},
 {k:'sample7',label:'7-day sample (browsers)',get:function(g){return g.sevenDaySample},html:function(g){return n(g.sevenDaySample)}}
];
var QCOLS=[MCOLS[0],
 {k:'pending',label:'Pending visits',get:function(g){return g.pendingVisits},html:function(g){return n(g.pendingVisits)}},
 {k:'temporary',label:'Temporary-ID visits',get:function(g){return g.temporaryIdentityVisits},html:function(g){return n(g.temporaryIdentityVisits)}},
 {k:'tails',label:'Unconfirmed-end visits',get:function(g){return g.unconfirmedTailVisits},html:function(g){return n(g.unconfirmedTailVisits)}}
];
function measTable(id,cols){return '<div class="wrap"><table id="'+id+'"><thead><tr>'+cols.map(function(c){return '<th>'+esc(c.label)+'</th>'}).join('')+'</tr></thead><tbody>'+M.games.map(function(g){return '<tr>'+cols.map(function(c){return '<td data-sort="'+esc(c.get(g))+'">'+c.html(g)+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>'}
function measSection(){
  var h='<h2>Qualified play</h2>';
  if(!M||!M.games)return h+'<p class="err">Play measurement could not load. Refresh to retry.</p>';
  if(!M.games.length)return h+'<p class="muted">No play measurement reports for this site. Add tally.measure() and accepted-action hooks to collect them.</p>';
  return h+'<p class="muted">First qualified visit per browser · observed minutes · all retained measurement data.</p>'+measTable('meas',MCOLS)+'<h2>Same-game returns</h2><p class="muted">Return percentages include counts; seven-day playtime includes repeat runs and later visits.</p>'+measTable('meas-returns',RCOLS)+'<h2>Measurement status</h2>'+measTable('meas-status',QCOLS);
}
function sortTable(table){
  var sort=sorts[table.id];if(!sort)return;
  var head=table.tHead.rows[0];
  Array.from(head.cells).forEach(function(th,i){if(i===sort.col)th.setAttribute('aria-sort',sort.dir<0?'descending':'ascending');else th.removeAttribute('aria-sort');th.querySelector('span').textContent=i===sort.col?(sort.dir<0?' ↓':' ↑'):' ↕'});
  var body=table.tBodies[0];
  function value(row){var s=row.cells[sort.col].getAttribute('data-sort');if(s==null)s=row.cells[sort.col].textContent;if(s==='')return null;return sort.col===0?s:Number(s)}
  Array.from(body.rows).sort(function(a,b){var x=value(a),y=value(b);if(x==null&&y==null)return 0;if(x==null)return 1;if(y==null)return -1;return (x<y?-1:x>y?1:0)*sort.dir}).forEach(function(row){body.appendChild(row)});
}
function enhance(){
  document.querySelectorAll('#app h2').forEach(function(heading){
    var key=heading.textContent,details=document.createElement('details'),summary=document.createElement('summary');details.dataset.section=key;details.open=key in sections?sections[key]:key==='Qualified play';heading.before(details);details.appendChild(summary);summary.appendChild(heading);
    while(details.nextElementSibling&&details.nextElementSibling.tagName!=='H2'&&!details.nextElementSibling.querySelector('h2'))details.appendChild(details.nextElementSibling);
  });
  document.querySelectorAll('#app table').forEach(function(table){
    table.setAttribute('aria-describedby','table-help');
    if(!table.tHead)table.createTHead().appendChild(table.rows[0]);
    var heads=Array.from(table.tHead.rows[0].cells),saved=sorts[table.id];
    if(saved&&saved.key){var col=heads.findIndex(function(th){return th.textContent===saved.key});if(col<0)delete sorts[table.id];else saved.col=col}
    heads.forEach(function(th,i){var label=th.textContent;th.scope='col';th.innerHTML='<button type="button">'+esc(label)+'<span aria-hidden="true"> ↕</span></button>';th.firstChild.onclick=function(){var s=sorts[table.id];sorts[table.id]={col:i,key:label,dir:s&&s.col===i?-s.dir:i===0?1:-1};sortTable(table)}});
    if(!sorts[table.id]&&table.id==='meas')sorts[table.id]={col:1,dir:-1};
    if(!sorts[table.id]&&table.id==='daily')sorts[table.id]={col:0,dir:-1};
    sortTable(table);
  });
}
function render(){
  document.querySelectorAll('#app details[data-section]').forEach(function(d){sections[d.dataset.section]=d.open});
  if(S.empty){$('#app').innerHTML=measSection()+'<p class="muted">No legacy events in this date range.</p>';enhance();return}
  var h='';
  h+='<div class="tiles">'+tile('live5m',S.live.visitors5m,'on site now','live')+tile('range_u',S.range.visitors,'visitors, '+span())+tile('range_pv',S.range.pageviews,'pageviews, '+span())+tile('today_u',S.today.uniques,'visitors today')+tile('all_u',S.allTimeVisitors,'visitors, all time')+tile('avg',secs(S.engagement.avgSeconds),'avg time on page')+'</div>';
  h+=measSection();
  if(sites.length>1)h+='<h2>All sites, '+span()+'</h2><div class="wrap"><table id="all-sites"><tr><th>site</th><th>visitors</th><th>events</th><th>last seen</th></tr>'+sites.map(function(s){return '<tr><td><a href="?site='+encodeURIComponent(s.site)+'">'+esc(s.site)+'</a></td><td data-sort="'+s.visitors+'">'+n(s.visitors)+'</td><td data-sort="'+s.events+'">'+n(s.events)+'</td><td data-sort="'+s.last+'">'+new Date(s.last).toLocaleString()+'</td></tr>'}).join('')+'</table></div>';
  var names=S.names.slice(0,9),rest=S.names.slice(9);
  h+='<h2>Daily</h2><div class="wrap"><table id="daily"><tr><th>day</th><th>visitors</th>'+names.map(function(x){return '<th>'+esc(x)+'</th>'}).join('')+'</tr>';
  S.daily.forEach(function(d){h+='<tr data-day="'+d.day+'"><td>'+d.day+'</td><td data-c="_u" data-sort="'+d.uniques+'">'+n(d.uniques)+'</td>'+names.map(function(x){var c=d.counts[x]||0;return '<td data-c="'+esc(x)+'" data-sort="'+c+'"'+(c?'':' class="z"')+'>'+n(c)+'</td>'}).join('')+'</tr>'});
  h+='</table></div>';
  if(rest.length)h+='<p class="muted">also counted: '+rest.map(function(x){return esc(x)+' ('+n(S.totals[x])+')'}).join(', ')+'</p>';
  h+='<div class="cols">';
  h+=col('Referrers',S.refs,function(r){return [r.ref,r.u]},['source','visitors']);
  h+=col('Pages',S.paths,function(r){return [r.path,r.u]},['path','visitors']);
  h+=col('Clicks',S.clicks,function(r){return [r.t,r.c]},['element','clicks']);
  h+=col('Errors',S.errors,function(r){return ['<span class="err">'+esc(r.m)+'</span>',r.c]},['message','count'],true);
  h+='</div>';
  var dev=S.devices,tot=(dev.touch||0)+(dev.mouse||0);
  if(tot)h+='<p class="muted">touch '+Math.round(100*(dev.touch||0)/tot)+'% · mouse '+Math.round(100*(dev.mouse||0)/tot)+'% · first seen '+(S.firstSeen?new Date(S.firstSeen).toLocaleDateString():'—')+'</p>';
  Object.keys(S.ab).forEach(function(k){
    var arms=Object.keys(S.ab[k]).sort(),ev={};arms.forEach(function(a){Object.keys(S.ab[k][a].events).forEach(function(e){ev[e]=1})});
    var evs=Object.keys(ev).sort(function(a,b){return (S.totals[b]||0)-(S.totals[a]||0)}).slice(0,8);
    var best={};evs.forEach(function(e){best[e]=Math.max.apply(null,arms.map(function(a){return S.ab[k][a].events[e]||0}))});
    h+='<h2>A/B — '+esc(k)+'</h2><p class="muted">unique visitors per arm who did each event; best per column highlighted</p><div class="wrap"><table id="ab-'+esc(k)+'"><tr><th>arm</th>'+evs.map(function(e){return '<th>'+esc(e)+'</th>'}).join('')+'</tr>';
    arms.forEach(function(a){h+='<tr><td>'+esc(a)+'</td>'+evs.map(function(e){var v=S.ab[k][a].events[e]||0;return '<td data-sort="'+v+'"'+(v&&v===best[e]?' class="best"':'')+'>'+n(v)+'</td>'}).join('')+'</tr>'});
    h+='</table></div>';
  });
  $('#app').innerHTML=h;
  enhance();
  $('#ticker').innerHTML=S.recent.map(line).join('')||'<div class="muted">no events yet</div>';
}
function span(){var f=S.from,t=S.to;return f===t?f:f+' to '+t}
function tile(id,v,label,cls){return '<div class="tile '+(cls||'')+'"><b id="t_'+id+'">'+(typeof v==='number'?n(v):esc(v))+'</b><span>'+label+'</span></div>'}
function col(title,rows,f,head,raw){if(!rows||!rows.length)return '<div><h2>'+title+'</h2><p class="muted">none</p></div>';return '<div><h2>'+title+'</h2><div class="wrap"><table id="'+title.toLowerCase()+'"><tr><th>'+head[0]+'</th><th>'+head[1]+'</th></tr>'+rows.map(function(r){var c=f(r);return '<tr><td>'+(raw?c[0]:esc(c[0]))+'</td><td data-sort="'+c[1]+'">'+n(c[1])+'</td></tr>'}).join('')+'</table></div></div>'}
function line(e,fresh){var p=e.props||{};var extra=e.name==='click'?p.t:e.name==='pageview'?(e.ref?'from '+e.ref:'')+(p.touch?' touch':''):e.name==='leave'?secs(p.s):e.name==='error'?p.m:JSON.stringify(p).replace(/"/g,'').slice(0,80);return '<div'+(fresh?' class="new"':'')+'>'+fmtT(e.ts)+' <span class="n">'+esc(e.name)+'</span> '+esc(e.vid.slice(0,4))+' '+esc(e.path||'')+' <span>'+esc(extra||'')+'</span></div>'}
function bump(el){if(!el)return;el.classList.remove('bump');void el.offsetWidth;el.classList.add('bump')}
var reloadTimer=null;
function onEvent(e){
  if(!site||S.empty){site=e.site;$('#site').value=site;load();return}
  if(e.site!==site)return;
  clearTimeout(reloadTimer);reloadTimer=setTimeout(load,2000);
  var t=$('#ticker');if(t.firstChild&&t.firstChild.className==='muted')t.innerHTML='';t.insertAdjacentHTML('afterbegin',line(e,true));while(t.children.length>60)t.removeChild(t.lastChild);
  if(!S.daily)return;
  if(S.names.indexOf(e.name)<0){S.names.push(e.name);S.totals[e.name]=0}
  S.totals[e.name]=(S.totals[e.name]||0)+1;
  var d=S.daily[0];if(d&&d.day===e.day){d.counts[e.name]=(d.counts[e.name]||0)+1;var cell=document.querySelector('#daily tr[data-day="'+e.day+'"] td[data-c="'+e.name+'"]');if(cell){cell.textContent=d.counts[e.name];cell.dataset.sort=d.counts[e.name];cell.classList.remove('z');bump(cell);sortTable($('#daily'))}else if(S.names.indexOf(e.name)>=9){}else render()}
  if(e.name==='pageview'&&d&&d.day===e.day){S.today.pageviews++;S.range.pageviews++;var el=$('#t_range_pv');el.textContent=n(S.range.pageviews);bump(el);var el2=$('#t_today_u');if(el2)el2.textContent=n(S.today.uniques)}
}
var esSite=null;function connect(){if(es&&esSite===site)return;if(es)es.close();esSite=site;es=new EventSource(BASE+'/stream?site='+encodeURIComponent(site));es.onopen=function(){$('#dot').classList.add('on')};es.onerror=function(){$('#dot').classList.remove('on')};es.onmessage=function(m){try{onEvent(JSON.parse(m.data))}catch(e){}}}
$('#site').onchange=function(){site=this.value;history.replaceState(null,'','?site='+encodeURIComponent(site));load()};
function setDates(n){var to=new Date(),from=new Date();from.setDate(from.getDate()-(n-1));$('#to').value=iso(to);$('#from').value=iso(from)}
function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
$('#days').onchange=function(){if(this.value){setDates(+this.value);load()}};
$('#from').onchange=$('#to').onchange=function(){$('#days').value='';load()};
(function(){var p=new URLSearchParams(location.search);
  if(p.get('from')&&p.get('to')){$('#from').value=p.get('from');$('#to').value=p.get('to');$('#days').value=''}
  else setDates(30);
  load();})();
setInterval(function(){if(document.visibilityState==='visible')load()},60000);
</script></body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
